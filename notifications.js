import {fail} from './suite-validation.js';
const defaults={email_enabled:false,assignment:true,comment:true,due:true};
export async function notifications({req,res,url,db,session,body,send}){
 const match=url.pathname.match(/^\/api\/agency\/notifications(?:\/(preferences|read-all|\d+))?$/);if(!match)return false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);const org=user.organization_id,target=match[1];
  const write=async(sql,values)=>{const c=await db.connect();try{await c.query('begin');await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket?.remoteAddress||'']);const r=await c.query(sql,values);await c.query('commit');return r;}catch(e){await c.query('rollback');throw e;}finally{c.release();}};
  if(target==='preferences'){
   if(req.method==='GET'){send(res,200,{preferences:(await db.query('select email_enabled,assignment,comment,due from agency_notification_preferences where organization_id=$1 and user_id=$2',[org,user.id])).rows[0]||defaults});return true;}
   if(req.method!=='PATCH')fail('Método no permitido',405);
   const b=await body(req);if(Object.keys(b).some(k=>!(k in defaults))||Object.values(b).some(v=>typeof v!=='boolean'))fail('Preferencias inválidas');
   const old=(await db.query('select * from agency_notification_preferences where organization_id=$1 and user_id=$2',[org,user.id])).rows[0]||defaults,p={...old,...b};
   await write('insert into agency_notification_preferences(organization_id,user_id,email_enabled,assignment,comment,due) values($1,$2,$3,$4,$5,$6) on conflict(organization_id,user_id) do update set email_enabled=excluded.email_enabled,assignment=excluded.assignment,comment=excluded.comment,due=excluded.due',[org,user.id,p.email_enabled,p.assignment,p.comment,p.due]);
   send(res,200,{ok:true});return true;
  }
  if(req.method==='GET'&&!target){
   const before=Number(url.searchParams.get('before')||0);if(!Number.isSafeInteger(before)||before<0)fail('Página inválida');
   const rows=(await db.query('select id,kind,title,body,work_order_id,project_id,created_at,read_at from agency_notifications where organization_id=$1 and user_id=$2 and ($3::bigint=0 or id<$3) order by id desc limit 30',[org,user.id,before])).rows;
   const unread=Number((await db.query('select count(*) as n from agency_notifications where organization_id=$1 and user_id=$2 and read_at is null',[org,user.id])).rows[0].n);
   send(res,200,{notifications:rows,unread,next:rows.length===30?rows.at(-1).id:null});return true;
  }
  if(req.method==='PATCH'&&target){
   if(target!=='read-all'&&!/^\d+$/.test(target))fail('Notificación inválida');
   const result=await write("update agency_notifications set read_at=coalesce(read_at,now()),email_status=case when email_status='pending' then 'skipped' else email_status end where organization_id=$1 and user_id=$2 and ($3::bigint is null or id=$3) returning id",[org,user.id,target==='read-all'?null:target]);
   if(target!=='read-all'&&!result.rows.length)fail('Notificación no encontrada',404);
   send(res,200,{ok:true});return true;
  }
  fail('Método no permitido',405);
 }catch(e){console.error(JSON.stringify({event:'notifications_error',status:e.status||500}));send(res,e.status||500,{error:e.status?e.message:'No se pudieron actualizar las notificaciones'});return true;}
}
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function notificationEmail(n,appUrl){
 const href=appUrl.replace(/\/$/,'')+(n.work_order_id?'/resumen?order='+n.work_order_id:'/proyectos');
 const text=n.title+'\n\n'+n.body+'\n\nAbrir Scale OS: '+href+'\n\nPodés desactivar estos correos en la campana de notificaciones → Preferencias.';
 return{subject:n.title.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g,' ').trim().slice(0,160),text,html:`<main style="font:16px/1.6 Arial,sans-serif;max-width:560px;margin:auto;padding:24px"><p>Scale OS · ${escape(n.organization_name)}</p><h1 style="font-size:22px">${escape(n.title)}</h1><p>${escape(n.body)}</p><p><a href="${escape(href)}">Abrir en Scale OS</a></p><hr><p style="font-size:12px">Recibís este aviso porque activaste los correos operativos. Podés desactivarlos en la campana → Preferencias.</p></main>`};
}
