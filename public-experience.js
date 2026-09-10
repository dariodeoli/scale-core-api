import crypto from 'node:crypto';
import {throttle} from './password-access.js';
import {seedPrivateDemo} from './demo-session.js';
import {accessRoles} from './invite-links.js';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export async function publicExperience({req,res,url,db,session,body,send,cookie,parseCookies}){
 if(!['/api/demo/start','/api/demo/role','/api/public/contact','/api/public/telemetry'].includes(url.pathname))return false;
 let c;
 try{
  if(req.method!=='POST')fail('Método no permitido',405);
  if(url.pathname==='/api/demo/start'&&req.headers?.origin!=='https://sistema.scaleparaguay.com')fail('Abrí el Demo desde sistema.scaleparaguay.com',403);
  const b=await body(req);
  if(url.pathname==='/api/public/telemetry'){
   if(!['page_view','mobile_view','whatsapp_click'].includes(b.name))fail('Evento inválido');
   if(!await throttle(db,'landing-telemetry',2000))fail('Límite temporal',429);
   await db.query("insert into events(organization_id,name,metadata) select id,$1,'{\"source\":\"scale-os-landing\"}'::jsonb from organizations where slug='scale' and active=true and demo_owner_user_id is null",[b.name]);
   send(res,202,{ok:true});return true;
  }
  if(url.pathname==='/api/demo/role'){
   const user=await session(req);if(!user?.demo_owner_user_id)fail('Solo disponible en un Demo privado',403);
   if(!accessRoles.includes(b.role))fail('Permiso inválido');
   await db.query('update sessions set demo_role=$1 where id=$2 and user_id=$3 and organization_id=$4',[b.role,parseCookies(req).scale_session,user.id,user.organization_id]);
   send(res,200,{ok:true});return true;
  }
  // Installation-wide cap remains effective even when a proxy masks/spoofs the visitor IP.
  if(!await throttle(db,'public:'+url.pathname,60))fail('Hay muchas solicitudes. Intentá nuevamente en unos minutos.',429);
  if(url.pathname==='/api/public/contact'){
   if(b.website){send(res,202,{ok:true});return true;}
   const clean=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
   const name=clean(b.name,100),company=clean(b.company,140),email=clean(b.email,254).toLowerCase(),phone=clean(b.phone,50),message=clean(b.message,1500);
   if(name.length<2||company.length<2||!/^\S+@\S+\.\S+$/.test(email)||b.consent!==true)fail('Completá nombre, empresa, correo y autorización de contacto.');
   if(!await throttle(db,'contact:'+email,3))fail('Ya recibimos tu consulta. Esperá unos minutos antes de reenviar.',429);
   c=await db.connect();await c.query('begin');
   const org=(await c.query("select id from organizations where slug='scale' and active=true and demo_owner_user_id is null")).rows[0];if(!org)fail('Formulario temporalmente no disponible',503);
   await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))",['contact:'+email]);
   const duplicate=(await c.query("select id from agency_leads where organization_id=$1 and email=$2 and notes like 'Origen: landing Scale OS.%' and created_at>now()-interval '1 day'",[org.id,email])).rows[0];
   if(!duplicate)await c.query("insert into agency_leads(organization_id,name,email,phone,notes) values($1,$2,$3,$4,$5)",[org.id,company+' · '+name,email,phone,'Origen: landing Scale OS. Autorizó contacto.\n'+message]);
   await c.query('commit');send(res,202,{ok:true});return true;
  }
  // Fresh browser session, never copied from a real agency. No reusable demo password.
  c=await db.connect();await c.query('begin');
  const uid=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');
  const user=(await c.query("insert into users(email,password_hash,is_demo_guest) values($1,'!public-demo-no-login',true) returning id",['visitante-'+uid+'@demo.example.invalid'])).rows[0];
  const org=(await c.query("insert into organizations(slug,name,demo_owner_user_id,demo_expires_at) values($1,'Agencia Horizonte',$2,now()+interval '1 day') returning id",['demo-session-'+uid,user.id])).rows[0];
  await c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org.id,user.id]);
  await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip','public-demo',true)",[String(user.id)]);
  await seedPrivateDemo(c,org.id,user.id);
  await c.query("insert into agency_user_profiles(organization_id,user_id,full_name) values($1,$2,'Visitante Demo') on conflict do nothing",[org.id,user.id]);
  await c.query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '1 day')",[token,user.id,org.id]);
  await c.query('commit');send(res,201,{ok:true},{'Set-Cookie':cookie('scale_session',token,86400)});return true;
 }catch(e){if(c)await c.query('rollback');send(res,e.status||500,{error:e.status?e.message:'No se pudo completar la solicitud'});return true;}finally{c?.release();}
}
