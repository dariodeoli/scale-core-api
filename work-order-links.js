import {fail,id,text} from './suite-validation.js';
import {externalLink} from './media-policy.js';
import {visibleRecord} from './record-lifecycle.js';

const writers=['owner','admin','management','production','editor'];
export async function workOrderLinks({req,res,url,db,session,body,send}){
 const match=url.pathname.match(/^\/api\/agency\/work-orders\/(\d+)\/links(?:\/(\d+))?$/);
 if(!match)return false;
 let c,tx=false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  const [,,linkId]=match,orderId=match[1],org=user.organization_id;
  if(req.method!=='GET'&&!writers.includes(user.role))fail('Sin permiso para modificar enlaces',403);
  c=await db.connect();await c.query('begin');tx=true;
  const order=(await c.query(`select o.id,o.project_id from agency_work_orders o join agency_projects p on p.id=o.project_id and p.organization_id=o.organization_id join agency_clients cl on cl.id=p.client_id and cl.organization_id=p.organization_id where o.id=$1 and o.organization_id=$2 and ${visibleRecord('o','work-orders')} and ${visibleRecord('p','projects')} and ${visibleRecord('cl','clients')} for update of o`,[orderId,org])).rows[0];
  if(!order)fail('Orden no encontrada',404);
  if(req.method==='GET'){
   const links=(await c.query('select id,label,url,created_by_user_id,created_at from agency_work_order_links where organization_id=$1 and work_order_id=$2 order by id',[org,order.id])).rows;
   await c.query('commit');tx=false;send(res,200,{links});return true;
  }
  await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);
  if(req.method==='POST'&&!linkId){
   const payload=await body(req),label=text(payload.label,120),link=externalLink(payload.url);if(label.length<2||!link)fail('Indicá un nombre y un enlace HTTPS');
   const row=(await c.query('insert into agency_work_order_links(organization_id,work_order_id,label,url,created_by_user_id) values($1,$2,$3,$4,$5) on conflict(organization_id,work_order_id,url) do update set label=excluded.label returning *',[org,order.id,label,link,user.id])).rows[0];
   await c.query('commit');tx=false;send(res,201,{link:row});return true;
  }
  if(req.method==='DELETE'&&linkId){
   const deleted=(await c.query('delete from agency_work_order_links where id=$1 and organization_id=$2 and work_order_id=$3 returning id',[id(linkId),org,order.id])).rows[0];
   if(!deleted)fail('Enlace no encontrado',404);
   await c.query('commit');tx=false;send(res,200,{ok:true});return true;
  }
  fail('Método no permitido',405);
 }catch(error){if(tx)await c.query('rollback');send(res,error.status||500,{error:error.status?error.message:'No se pudo gestionar los enlaces'});return true;}finally{c?.release();}
}
