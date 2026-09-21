import crypto from 'node:crypto';
import {roleCan} from './permissions.js';
import {emailShell} from './email-brand.js';
import bcrypt from 'bcryptjs';
import {throttle,validatePassword} from './password-access.js';
import {externalLink} from './media-policy.js';
import {owned} from './suite-validation.js';
import {visibleRecord} from './record-lifecycle.js';

// Until the dedicated client subdomain is configured, the portal is served
// through the authenticated app origin under /cliente.  Keeping the public
// origin configurable makes the later DNS cutover explicit and avoids
// trusting a request Host header to compose invitation URLs.
const configuredPortalOrigin=(process.env.CLIENT_PORTAL_ORIGIN||'https://app.scaleparaguay.com/cliente').trim().replace(/\/$/,'');
let clientOrigin;
try{
 const parsed=new URL(configuredPortalOrigin);
 if(parsed.protocol!=='https:'||!['app.scaleparaguay.com','cliente.scaleparaguay.com'].includes(parsed.hostname)||parsed.username||parsed.password||parsed.search||parsed.hash)throw Error('unsafe');
 clientOrigin=parsed.toString().replace(/\/$/,'');
}catch{throw Error('CLIENT_PORTAL_ORIGIN debe ser un origen HTTPS permitido de Scale');}
const clientOrigins=new Set(['https://app.scaleparaguay.com','https://cliente.scaleparaguay.com',new URL(clientOrigin).origin]);
export const clientPortalUrl=path=>`${clientOrigin}/${String(path).replace(/^\/+/, '')}`;

const fail=(message,status=400,details={})=>{throw Object.assign(Error(message),{status},details);};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const token=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:fail('Enlace inválido');
const id=value=>/^\d+$/.test(String(value))&&Number(value)>0?String(value):fail('Identificador inválido');
const text=(value,max=2000)=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=max?value.trim():fail('Texto inválido');
const email=value=>{const normalized=typeof value==='string'?value.trim().toLowerCase():'';if(!/^\S+@\S+\.\S+$/.test(normalized)||normalized.length>254)fail('Correo inválido');return normalized;};
const portalCookie=(value,maxAge)=>`__Host-scale_client_session=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
const readCookie=req=>Object.fromEntries((req.headers?.cookie||'').split(';').filter(Boolean).map(value=>{const at=value.indexOf('=');return[value.slice(0,at).trim(),decodeURIComponent(value.slice(at+1))];}));
const sameOrigin=req=>{const origin=req.headers?.origin;if(origin&&!clientOrigins.has(origin))fail('Origen no permitido',403);};
async function portalSession(db,req){
 const raw=readCookie(req)['__Host-scale_client_session'];if(!raw||!/^[a-f0-9]{64}$/.test(raw))return null;
 const row=(await db.query(`select s.token_hash,u.id,u.email,u.full_name
  from client_portal_sessions s join client_portal_users u on u.id=s.portal_user_id
  where s.token_hash=$1 and s.expires_at>now() and u.disabled_at is null`,[hash(raw)])).rows[0]||null;
 if(row)await db.query('update client_portal_sessions set last_seen_at=now() where token_hash=$1',[row.token_hash]);
 return row;
}
async function scopedDelivery(c,userId,deliveryId){
 // Las fechas de la entrega viajan como texto `YYYY-MM-DD`: un `date` serializado
 // como timestamp hacía que el portal mostrara el día anterior y una hora inventada.
 // Papelera: un cliente, proyecto u orden archivado deja de servir entregas al portal.
 const row=(await c.query(`select d.id,d.organization_id,d.work_order_id,d.title,d.summary,d.asset_name,d.asset_url,d.version,d.published_at,
   w.status as work_order_status,to_char(w.due_date,'YYYY-MM-DD') as due_date,w.due_time,p.name as project_name,cl.name as client_name
  from client_portal_deliveries d join agency_work_orders w on w.id=d.work_order_id and w.organization_id=d.organization_id
  join agency_projects p on p.id=w.project_id and p.organization_id=d.organization_id
  join agency_clients cl on cl.id=p.client_id and cl.organization_id=d.organization_id
  join organizations o on o.id=d.organization_id
  join client_portal_grants g on g.organization_id=d.organization_id and g.client_id=p.client_id and g.portal_user_id=$1 and g.active
  where d.id=$2 and d.visible and d.asset_url is not null and cl.active and o.active and w.status in ('approved','published')
   and ${visibleRecord('cl','clients')} and ${visibleRecord('p','projects')} and ${visibleRecord('w','work-orders')}`,[userId,id(deliveryId)])).rows[0];
 if(!row)fail('Entrega no encontrada',404);return row;
}
async function validInvite(c,raw,{lock=false}={}){
 const suffix=lock?' for update':'';
 const invite=(await c.query(`select i.*,c.name as client_name,o.name as organization_name,c.active as client_active,o.active as organization_active
  from client_portal_invites i join agency_clients c on c.id=i.client_id and c.organization_id=i.organization_id
  join organizations o on o.id=i.organization_id where i.token_hash=$1${suffix}`,[hash(token(raw))])).rows[0];
 if(!invite)fail('Este enlace venció o fue desactivado.',410);
 if(invite.revoked_at)fail('Este enlace venció o fue desactivado.',410,{link_status:'revoked'});
 if(invite.accepted_at)fail('Este enlace venció o fue desactivado.',410,{link_status:'used'});
 if(new Date(invite.expires_at)<=new Date())fail('Este enlace venció o fue desactivado.',410,{link_status:'expired'});
 if(!invite.client_active||!invite.organization_active)fail('Este enlace venció o fue desactivado.',410);
 return invite;
}
// Invitar y revocar clientes sigue al ADR (owner/admin/management/production, sin
// collaborator); publicar entregas y revisiones sigue con portal.manage.
function actor(user,capability='portal.manage',message='Sin permiso para gestionar el portal de clientes'){if(!user||!roleCan(user,capability))fail(message,403);}
async function notifyPortalActivity(c,delivery,{label,body,dedupe}){
 const order=(await c.query('select w.title,w.project_id from agency_work_orders w where w.id=$1 and w.organization_id=$2',[delivery.work_order_id,delivery.organization_id])).rows[0];
 if(!order)return;
 const recipients=(await c.query("select user_id::text as user_id from agency_record_assignees where organization_id=$1 and kind='work-orders' and record_id=$2 order by user_id",[delivery.organization_id,delivery.work_order_id])).rows;
 const subject=`${label} ${order.title}`;
 for(const recipient of recipients)await c.query("select enqueue_agency_notification($1,$2,'comment',$3,$4,$5,$6,$7,$8)",[delivery.organization_id,recipient.user_id,subject,body,delivery.work_order_id,order.project_id,dedupe,null]);
}
export function clientPortalResetEmail({token}){
 const resetUrl=`${clientOrigin}/recuperar?resetToken=${token}`;
 // El shell escapa el href una sola vez; pre-escaparlo rompía cualquier URL con `&`.
 return {subject:'Restablecé tu contraseña del portal de cliente',text:`Recibimos una solicitud para restablecer la contraseña de tu Portal del Cliente de Scale OS. Abrí este enlace dentro de una hora: ${resetUrl}\n\nSi no lo solicitaste, podés ignorar este correo.`,html:emailShell({
  eyebrow:'Portal del cliente',
  title:'Restablecé tu contraseña',
  lead:'Recibimos una solicitud para tu Portal del Cliente de Scale OS. Este enlace vence en una hora; si no lo solicitaste, podés ignorar este correo.',
  cta:{label:'Elegir una contraseña nueva',href:resetUrl},
  footerNote:'Scale OS · Portal del cliente',
 })};
}

export function clientPortalInviteEmail({organizationName,clientName,url}){
 // El asunto viaja a un encabezado: sin controles ni saltos de línea.
 const clean=value=>String(value??'').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g,' ').trim();
 const org=clean(organizationName)||'tu agencia',client=clean(clientName)||'el cliente';
 const subject=`Te invitaron al portal de ${client} · Scale OS`.slice(0,160);
 const text=`Te invitaron a revisar las entregas de ${client} en el Portal del Cliente de ${org}.\n\nAbrí tu portal: ${url}\n\nEste enlace es personal y vence pronto. Si no lo esperabas, podés ignorarlo.\n\nScale OS · Portal del cliente`;
 return{subject,text,html:emailShell({
  eyebrow:'Portal del cliente',
  title:`Entregas de ${client}`,
  lead:`${org} te invita a revisar entregas desde tu portal privado. No necesitás una cuenta.`,
  cta:{label:'Ver entregas',href:url},
  footer:'Este enlace es personal y vence pronto. Si no lo esperabas, podés ignorarlo.',
  footerNote:'Scale OS · Portal del cliente',
 })};
}
export async function clientPortalGoogleInvite(db,raw){return validInvite(db,raw);}
export async function acceptClientPortalGoogleInvite({db,inviteId,email:googleEmail,fullName}){
 const c=await db.connect();let transaction=false;
 try{
  await c.query('begin');transaction=true;
  const invite=(await c.query(`select i.*,c.active as client_active,o.active as organization_active
   from client_portal_invites i join agency_clients c on c.id=i.client_id and c.organization_id=i.organization_id
   join organizations o on o.id=i.organization_id where i.id=$1 for update`,[inviteId])).rows[0];
  if(!invite||invite.revoked_at||invite.accepted_at||!invite.client_active||!invite.organization_active||new Date(invite.expires_at)<=new Date())fail('Esta invitación venció o fue desactivada.',410);
  if(invite.email_normalized!==email(googleEmail))fail('El correo de Google debe coincidir con el correo invitado.',403);
  let user=(await c.query('select * from client_portal_users where email_normalized=$1 for update',[invite.email_normalized])).rows[0];
  if(user){
   if(user.disabled_at)fail('Esta cuenta del portal está desactivada.',403);
   if(String(user.organization_id)!==String(invite.organization_id)||String(user.client_id)!==String(invite.client_id))fail('Esta dirección ya está vinculada a otro cliente.',409);
  }else user=(await c.query('insert into client_portal_users(organization_id,client_id,email,email_normalized,password_hash,full_name) values($1,$2,$3,$4,null,$5) returning *',[invite.organization_id,invite.client_id,invite.email_normalized,invite.email_normalized,text(fullName||invite.email_normalized,120)])).rows[0];
  await c.query('insert into client_portal_grants(organization_id,client_id,portal_user_id,granted_by_user_id) values($1,$2,$3,$4) on conflict(organization_id,client_id,portal_user_id) do update set active=true,revoked_at=null,revoked_by_user_id=null',[invite.organization_id,invite.client_id,user.id,invite.invited_by_user_id]);
  await c.query('update client_portal_invites set accepted_at=now() where id=$1',[invite.id]);
  const rawSession=crypto.randomBytes(32).toString('hex');
  await c.query("insert into client_portal_sessions(token_hash,portal_user_id,expires_at) values($1,$2,now()+interval '7 days')",[hash(rawSession),user.id]);
  await c.query('commit');transaction=false;return {rawSession};
 }catch(error){if(transaction)await c.query('rollback');throw error;}finally{c.release();}
}
export async function clientPortal({req,res,url,db,session,body,send,sendPasswordReset,sendInvite,emailAvailable=true}){
 const invitePreview=url.pathname==='/api/client-portal/invites/preview';
 const inviteAccept=url.pathname==='/api/client-portal/invites/accept';
  const login=url.pathname==='/api/client-portal/auth/login';
 const passwordRequest=url.pathname==='/api/client-portal/auth/password/request';
 const passwordReset=url.pathname==='/api/client-portal/auth/password/reset';
 const logout=url.pathname==='/api/client-portal/auth/logout';
 const me=url.pathname==='/api/client-portal/me';
  const deliveryMatch=url.pathname.match(/^\/api\/client-portal\/deliveries\/(\d+)(?:\/(comments|decision|download|activity))?$/);
 const deliveries=url.pathname==='/api/client-portal/deliveries';
 const internalInvite=url.pathname.match(/^\/api\/agency\/clients\/(\d+)\/client-portal-invites$/);
 const revokeInvite=url.pathname.match(/^\/api\/agency\/client-portal-invites\/(\d+)\/revoke$/);
 const revokeGrant=url.pathname.match(/^\/api\/agency\/clients\/(\d+)\/portal-access\/grants\/(\d+)\/revoke$/);
 const internalDelivery=url.pathname.match(/^\/api\/agency\/work-orders\/(\d+)\/client-portal-delivery$/);
 if(!invitePreview&&!inviteAccept&&!login&&!passwordRequest&&!passwordReset&&!logout&&!me&&!deliveries&&!deliveryMatch&&!internalInvite&&!revokeInvite&&!revokeGrant&&!internalDelivery)return false;
 let c,transaction=false;
 try{
  if(internalInvite||revokeInvite||revokeGrant||internalDelivery){
   const employee=await session(req);
   actor(employee,internalDelivery?'portal.manage':'portal-access.manage',internalDelivery?'Sin permiso para gestionar el portal de clientes':'Sin permiso para gestionar los accesos del portal de clientes');
   c=await db.connect();await c.query('begin');transaction=true;
   await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(employee.id),req.socket.remoteAddress||'']);
   if(internalInvite){
    const client=await owned(c,'agency_clients',internalInvite[1],employee.organization_id);
    if(req.method==='GET'){
     const invites=(await c.query('select id,email_normalized,expires_at,accepted_at,revoked_at,created_at from client_portal_invites where organization_id=$1 and client_id=$2 order by id desc',[employee.organization_id,client.id])).rows;
     const grants=(await c.query('select g.id,g.active,g.granted_at,g.revoked_at,u.email,u.full_name from client_portal_grants g join client_portal_users u on u.id=g.portal_user_id where g.organization_id=$1 and g.client_id=$2 order by g.id desc',[employee.organization_id,client.id])).rows;
     await c.query('commit');transaction=false;send(res,200,{invites,grants});return true;
    }
    if(req.method!=='POST')fail('Método no permitido',405);const b=await body(req),recipient=email(b.email);
    if(!await throttle(db,'client-portal-invite:'+employee.organization_id+':'+recipient,8))fail('Demasiadas invitaciones para este correo',429);
    const raw=crypto.randomBytes(32).toString('hex');const ttl=Number(b.expiresInDays||7);if(!Number.isInteger(ttl)||ttl<1||ttl>30)fail('La invitación debe vencer entre 1 y 30 días');const expiresAt=new Date(Date.now()+ttl*86400000).toISOString();
    await c.query('update client_portal_invites set revoked_at=now() where organization_id=$1 and client_id=$2 and email_normalized=$3 and accepted_at is null and revoked_at is null',[employee.organization_id,client.id,recipient]);
    const invite=(await c.query("insert into client_portal_invites(organization_id,client_id,email_normalized,token_hash,expires_at,invited_by_user_id) values($1,$2,$3,$4,$5,$6) returning id,expires_at",[employee.organization_id,client.id,recipient,hash(raw),expiresAt,employee.id])).rows[0];
    await c.query('commit');transaction=false;
    if(typeof sendInvite==='function'){
     const orgName=(await c.query('select name from organizations where id=$1',[employee.organization_id])).rows[0]?.name||'tu agencia';
     const clientName=(await c.query('select name from agency_clients where id=$1 and organization_id=$2',[client.id,employee.organization_id])).rows[0]?.name||'el cliente';
     await sendInvite(recipient,clientPortalInviteEmail({organizationName:orgName,clientName,url:`${clientOrigin}/invitacion?token=${raw}`})).catch(()=>false);
    }
    send(res,201,{invite:{...invite,email:recipient},url:`${clientOrigin}/invitacion?token=${raw}`});return true;
   }
   if(revokeInvite){
    if(req.method!=='POST')fail('Método no permitido',405);const result=(await c.query('update client_portal_invites set revoked_at=now() where id=$1 and organization_id=$2 and accepted_at is null and revoked_at is null returning id',[id(revokeInvite[1]),employee.organization_id])).rows[0];
    if(!result)fail('Invitación no disponible',404);await c.query('commit');transaction=false;send(res,200,{ok:true});return true;
   }
   if(revokeGrant){
    if(req.method!=='POST')fail('Método no permitido',405);
    const client=await owned(c,'agency_clients',revokeGrant[1],employee.organization_id);
    const grant=(await c.query('update client_portal_grants set active=false,revoked_at=now(),revoked_by_user_id=$1 where id=$2 and organization_id=$3 and client_id=$4 and active returning id,portal_user_id',[employee.id,id(revokeGrant[2]),employee.organization_id,client.id])).rows[0];
    if(!grant)fail('Acceso no disponible',404);
    await c.query('delete from client_portal_sessions where portal_user_id=$1 and not exists(select 1 from client_portal_grants g where g.portal_user_id=$1 and g.organization_id=$2 and g.active)',[grant.portal_user_id,employee.organization_id]);
    // Una invitación pendiente del mismo correo volvería a activar el acceso revocado.
    await c.query('update client_portal_invites set revoked_at=now() where organization_id=$1 and client_id=$2 and accepted_at is null and revoked_at is null and email_normalized=(select email_normalized from client_portal_users where id=$3)',[employee.organization_id,client.id,grant.portal_user_id]);
    await c.query('commit');transaction=false;send(res,200,{ok:true});return true;
   }
   const order=await owned(c,'agency_work_orders',internalDelivery[1],employee.organization_id);
   const project=(await c.query('select p.*,cl.name as client_name from agency_projects p join agency_clients cl on cl.id=p.client_id and cl.organization_id=p.organization_id where p.id=$1 and p.organization_id=$2',[order.project_id,employee.organization_id])).rows[0];if(!project)fail('Proyecto no encontrado',404);
   if(req.method==='GET'){
    const delivery=(await c.query('select id,visible,title,summary,asset_name,asset_url,version,published_at,updated_at from client_portal_deliveries where organization_id=$1 and work_order_id=$2',[employee.organization_id,order.id])).rows[0]||null;
    await c.query('commit');transaction=false;send(res,200,{delivery});return true;
   }
   if(!['POST','PATCH'].includes(req.method))fail('Método no permitido',405);const b=await body(req);
   if(req.method==='PATCH'&&b.visible===false){await c.query('update client_portal_deliveries set visible=false,updated_at=now() where organization_id=$1 and work_order_id=$2',[employee.organization_id,order.id]);await c.query('commit');transaction=false;send(res,200,{ok:true});return true;}
   if(!['approved','published'].includes(order.status))fail('Sólo se pueden publicar entregables aprobados internamente',409);
   const title=text(b.title||order.title,180),summary=typeof b.summary==='string'?b.summary.trim().slice(0,2000):'',assetName=text(b.assetName||'Abrir archivo',180);
   // Sin enlace HTTPS no se publica: era un 500 de columna no nula.
   const previous=(await c.query('select asset_url from client_portal_deliveries where organization_id=$1 and work_order_id=$2',[employee.organization_id,order.id])).rows[0]?.asset_url||null;
   const assetUrl=externalLink(b.assetUrl)||previous;if(!assetUrl)fail('Pegá un enlace HTTPS del archivo para publicar la entrega');
   const delivery=(await c.query(`insert into client_portal_deliveries(organization_id,work_order_id,visible,title,summary,asset_name,asset_url,published_by_user_id,published_at)
    values($1,$2,true,$3,$4,$5,$6,$7,now()) on conflict(organization_id,work_order_id) do update set visible=true,title=excluded.title,summary=excluded.summary,asset_name=excluded.asset_name,asset_url=excluded.asset_url,version=client_portal_deliveries.version+1,published_by_user_id=excluded.published_by_user_id,published_at=now(),updated_at=now() returning *`,[employee.organization_id,order.id,title,summary,assetName,assetUrl,employee.id])).rows[0];
   await c.query('commit');transaction=false;send(res,200,{delivery});return true;
  }
  if(invitePreview){if(req.method!=='GET')fail('Método no permitido',405);const invite=await validInvite(db,url.searchParams.get('token')||'');send(res,200,{organizationName:invite.organization_name,clientName:invite.client_name,expiresAt:invite.expires_at});return true;}
  sameOrigin(req);
  if(inviteAccept){
   if(req.method!=='POST')fail('Método no permitido',405);const b=await body(req),raw=token(b.token);if(!await throttle(db,'client-portal-accept:'+hash(raw),5))fail('Demasiados intentos',429);
   if(typeof b.password!=='string'||b.password.length<8||b.password.length>128)fail('Usá una contraseña de 8 a 128 caracteres');
   c=await db.connect();await c.query('begin');transaction=true;const invite=await validInvite(c,raw,{lock:true});
   let user=(await c.query('select * from client_portal_users where email_normalized=$1 for update',[invite.email_normalized])).rows[0];
   if(user){
    if(user.disabled_at||String(user.organization_id)!==String(invite.organization_id)||String(user.client_id)!==String(invite.client_id))fail('Esta dirección ya está vinculada a otro cliente.',409);
    if(!user.password_hash||!await bcrypt.compare(b.password,user.password_hash))fail('Esta dirección ya tiene una cuenta. Ingresá con su contraseña o usá Google.',409);
   }else {validatePassword(b.password,invite.email_normalized);user=(await c.query('insert into client_portal_users(organization_id,client_id,email,email_normalized,password_hash,full_name) values($1,$2,$3,$4,$5,$6) returning *',[invite.organization_id,invite.client_id,invite.email_normalized,invite.email_normalized,await bcrypt.hash(b.password,12),text(b.fullName,120)])).rows[0];}
   await c.query('insert into client_portal_grants(organization_id,client_id,portal_user_id,granted_by_user_id) values($1,$2,$3,$4) on conflict(organization_id,client_id,portal_user_id) do update set active=true,revoked_at=null,revoked_by_user_id=null',[invite.organization_id,invite.client_id,user.id,invite.invited_by_user_id]);
   await c.query('update client_portal_invites set accepted_at=now() where id=$1',[invite.id]);const rawSession=crypto.randomBytes(32).toString('hex');
   await c.query("insert into client_portal_sessions(token_hash,portal_user_id,expires_at) values($1,$2,now()+interval '7 days')",[hash(rawSession),user.id]);
   await c.query('commit');transaction=false;send(res,201,{ok:true},{'Set-Cookie':portalCookie(rawSession,604800)});return true;
  }
  if(login){
   if(req.method!=='POST')fail('Método no permitido',405);const b=await body(req),address=email(b.email);if(!await throttle(db,'client-portal-login:'+address,10))fail('Demasiados intentos. Esperá 15 minutos.',429);
   const user=(await db.query('select u.* from client_portal_users u where u.email_normalized=$1 and u.disabled_at is null and exists(select 1 from client_portal_grants g join organizations o on o.id=g.organization_id join agency_clients c on c.id=g.client_id and c.organization_id=g.organization_id where g.portal_user_id=u.id and g.active and o.active and c.active)',[address])).rows[0];
   if(!user||!user.password_hash||typeof b.password!=='string'||!await bcrypt.compare(b.password,user.password_hash))fail('Credenciales inválidas',401);const raw=crypto.randomBytes(32).toString('hex');await db.query("insert into client_portal_sessions(token_hash,portal_user_id,expires_at) values($1,$2,now()+interval '7 days')",[hash(raw),user.id]);send(res,200,{ok:true},{'Set-Cookie':portalCookie(raw,604800)});return true;
  }
  if(passwordRequest){
   if(req.method!=='POST')fail('Método no permitido',405);
   if(!emailAvailable||typeof sendPasswordReset!=='function')fail('La recuperación por correo todavía no está disponible. Usá Google o contactá a quien te invitó.',503);
   const b=await body(req),address=email(b.email);
   if(await throttle(db,'client-portal-reset:'+address,3)){
    const portalUser=(await db.query(`select u.id from client_portal_users u where u.email_normalized=$1 and u.disabled_at is null and exists(select 1 from client_portal_grants g join organizations o on o.id=g.organization_id join agency_clients c on c.id=g.client_id and c.organization_id=g.organization_id where g.portal_user_id=u.id and g.active and o.active and c.active)`,[address])).rows[0];
    if(portalUser){
     const raw=crypto.randomBytes(32).toString('hex');
     await db.query('delete from client_portal_password_resets where portal_user_id=$1',[portalUser.id]);
     await db.query("insert into client_portal_password_resets(token_hash,portal_user_id,expires_at) values($1,$2,now()+interval '1 hour')",[hash(raw),portalUser.id]);
     await sendPasswordReset(address,raw).catch(()=>false);
    }
   }
   send(res,202,{message:'Si ese correo tiene acceso al portal, recibirá un enlace para restablecer su contraseña.'});return true;
  }
  if(passwordReset){
   if(req.method!=='POST')fail('Método no permitido',405);
   const b=await body(req),raw=token(b.token),address=typeof b.email==='string'?b.email:'';validatePassword(b.password,address);
   c=await db.connect();await c.query('begin');transaction=true;
   const saved=(await c.query('delete from client_portal_password_resets where token_hash=$1 and expires_at>now() returning portal_user_id',[hash(raw)])).rows[0];
   if(!saved)fail('El enlace venció o ya fue utilizado. Solicitá otro.',400);
   await c.query('update client_portal_users set password_hash=$1,updated_at=now() where id=$2',[await bcrypt.hash(b.password,12),saved.portal_user_id]);
   await c.query('delete from client_portal_sessions where portal_user_id=$1',[saved.portal_user_id]);
   await c.query('delete from client_portal_password_resets where portal_user_id=$1',[saved.portal_user_id]);
   await c.query('commit');transaction=false;send(res,200,{ok:true});return true;
  }
  const user=await portalSession(db,req);if(!user)fail('Ingresá al portal de cliente',401);
  if(logout){if(req.method!=='POST')fail('Método no permitido',405);await db.query('delete from client_portal_sessions where token_hash=$1',[user.token_hash]);send(res,200,{ok:true},{'Set-Cookie':portalCookie('',0)});return true;}
  if(me){if(req.method!=='GET')fail('Método no permitido',405);const client=(await db.query('select o.name as organization_name,c.name as client_name from client_portal_users u join organizations o on o.id=u.organization_id join agency_clients c on c.id=u.client_id and c.organization_id=u.organization_id where u.id=$1 and o.active and c.active',[user.id])).rows[0]||null;send(res,200,{user:{fullName:user.full_name,email:user.email},client});return true;}
  if(deliveries){if(req.method!=='GET')fail('Método no permitido',405);const rows=(await db.query(`select distinct d.id,d.title,d.summary,d.asset_name,d.version,d.published_at,w.title as work_order_title,to_char(w.due_date,'YYYY-MM-DD') as due_date,w.due_time,p.name as project_name,c.name as client_name
   from client_portal_deliveries d join agency_work_orders w on w.id=d.work_order_id and w.organization_id=d.organization_id join agency_projects p on p.id=w.project_id and p.organization_id=d.organization_id join agency_clients c on c.id=p.client_id and c.organization_id=d.organization_id join organizations o on o.id=d.organization_id join client_portal_grants g on g.organization_id=d.organization_id and g.client_id=p.client_id and g.portal_user_id=$1 and g.active
   where d.visible and d.asset_url is not null and w.status in ('approved','published') and c.active and o.active
    and ${visibleRecord('c','clients')} and ${visibleRecord('p','projects')} and ${visibleRecord('w','work-orders')} order by d.published_at desc,d.id desc`,[user.id])).rows;send(res,200,{deliveries:rows});return true;}
  c=await db.connect();await c.query('begin');transaction=true;const delivery=await scopedDelivery(c,user.id,deliveryMatch[1]);
  if(!deliveryMatch[2]){
   if(req.method!=='GET')fail('Método no permitido',405);const comments=(await c.query('select c.id,c.body,c.created_at,u.full_name as author_name from client_portal_delivery_comments c join client_portal_users u on u.id=c.portal_user_id where c.delivery_id=$1 and c.organization_id=$2 order by c.created_at,c.id',[delivery.id,delivery.organization_id])).rows;
   const decision=(await c.query('select decision,created_at,updated_at from client_portal_delivery_decisions where delivery_id=$1 and portal_user_id=$2 and version=$3',[delivery.id,user.id,delivery.version])).rows[0]||null;
   // Only named links explicitly marked visible are exposed; asset URLs are
   // already excluded above and the links table enforces HTTPS-only values.
   const links=(await c.query('select id,label,url from agency_work_order_links where organization_id=$1 and work_order_id=$2 and visible_to_client order by id',[delivery.organization_id,delivery.work_order_id])).rows;
   // El portal no necesita ids internos: se publican solo los campos del contrato.
   const {asset_url,organization_id,work_order_id,...publicDelivery}=delivery;
   await c.query('commit');transaction=false;send(res,200,{delivery:publicDelivery,links,comments,decision});return true;
  }
  if(deliveryMatch[2]==='activity'){
   if(req.method!=='GET')fail('Método no permitido',405);
   // Read-only chronological log derived from portal tables plus the audited
   // version bumps. Scope stays inside the granted client through scopedDelivery.
   const activity=(await c.query(`
    select entry.kind, entry.at, entry.version, entry.actor_name, entry.summary from (
     select 'decision' as kind, dec.created_at as at, dec.version, u.full_name as actor_name,
      case dec.decision when 'approved' then 'Aprobó la entrega' else 'Solicitó cambios' end as summary
     from client_portal_delivery_decisions dec join client_portal_users u on u.id=dec.portal_user_id
     where dec.delivery_id=$1 and dec.organization_id=$2
     union all
     select 'comment', cm.created_at, null, u.full_name, left(cm.body,160)
     from client_portal_delivery_comments cm join client_portal_users u on u.id=cm.portal_user_id
     where cm.delivery_id=$1 and cm.organization_id=$2
     union all
     select 'download', dl.created_at, null, u.full_name, 'Descargó el entregable'
     from client_portal_delivery_downloads dl join client_portal_users u on u.id=dl.portal_user_id
     where dl.delivery_id=$1 and dl.organization_id=$2
     union all
     select 'version', a.created_at, (a.after_state->>'version')::int, coalesce(nullif(trim(i.full_name),''),i.email), 'Nueva versión publicada'
     from agency_operation_audit a
     left join organization_person_identity i on i.organization_id=a.organization_id and i.user_id=(a.after_state->>'published_by_user_id')::bigint
     where a.organization_id=$2 and a.table_name='client_portal_deliveries' and a.action='UPDATE'
      and coalesce((a.after_state->>'version')::int,0)>coalesce((a.before_state->>'version')::int,0)
      and (a.after_state->>'id')::bigint=$1
    ) entry order by entry.at asc, entry.kind desc`,[delivery.id,delivery.organization_id])).rows;
   await c.query('commit');transaction=false;send(res,200,{activity},{'Cache-Control':'no-store'});return true;
  }
  if(deliveryMatch[2]==='download'){
   if(req.method!=='GET')fail('Método no permitido',405);
   await c.query('insert into client_portal_delivery_downloads(organization_id,delivery_id,portal_user_id,request_ip) values($1,$2,$3,$4)',[delivery.organization_id,delivery.id,user.id,req.socket.remoteAddress||'']);
   await c.query('commit');transaction=false;res.writeHead(302,{Location:delivery.asset_url,'Referrer-Policy':'no-referrer'});res.end();return true;
  }
  if(req.method!=='POST')fail('Método no permitido',405);const b=await body(req);
  // Comentarios y decisiones son públicos en el portal: se limitan por cuenta.
  if(!await throttle(db,'client-portal-message:'+user.id,20))fail('Demasiados mensajes seguidos. Esperá unos minutos.',429);
  if(deliveryMatch[2]==='comments'){
   const comment=(await c.query('insert into client_portal_delivery_comments(organization_id,delivery_id,portal_user_id,body) values($1,$2,$3,$4) returning id,body,created_at',[delivery.organization_id,delivery.id,user.id,text(b.body)])).rows[0];
   await notifyPortalActivity(c,delivery,{label:'Comentario del cliente en',body:comment.body,dedupe:`portal-comment-${delivery.id}-${comment.id}`});
   await c.query('commit');transaction=false;send(res,201,{comment});return true;
  }
  const decision=['approved','changes_requested'].includes(b.decision)?b.decision:fail('Decisión inválida');let commentId=null,decisionBody='';
  if(b.comment!==undefined&&String(b.comment).trim()){const commentRow=(await c.query('insert into client_portal_delivery_comments(organization_id,delivery_id,portal_user_id,body) values($1,$2,$3,$4) returning id,body',[delivery.organization_id,delivery.id,user.id,text(b.comment)])).rows[0];commentId=commentRow.id;decisionBody=commentRow.body;}
  if(decision==='changes_requested'&&!commentId)fail('Explicá los cambios que necesitás');
  const result=(await c.query(`insert into client_portal_delivery_decisions(organization_id,delivery_id,portal_user_id,version,decision,comment_id) values($1,$2,$3,$4,$5,$6)
   on conflict(delivery_id,portal_user_id,version) do update set decision=excluded.decision,comment_id=excluded.comment_id,updated_at=now() returning decision,created_at,updated_at`,[delivery.organization_id,delivery.id,user.id,delivery.version,decision,commentId])).rows[0];
  await notifyPortalActivity(c,delivery,{label:decision==='approved'?'El cliente aprobó':'El cliente pidió cambios en',body:decisionBody,dedupe:`portal-decision-${delivery.id}-${delivery.version}-${user.id}`});
  await c.query('commit');transaction=false;send(res,200,{decision:result});return true;
 }catch(error){if(transaction)await c.query('rollback');console.error(JSON.stringify({event:'client_portal_error',status:error.status||500,code:error.code||null,message:error.status?null:error.message}));const linkStatus=['expired','revoked','used'].includes(error.link_status)?{link_status:error.link_status}:{};send(res,error.status||500,{error:error.status?error.message:'No se pudo completar la operación',...linkStatus});return true;}finally{c?.release();}
}
