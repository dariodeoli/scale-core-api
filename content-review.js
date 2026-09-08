import crypto from 'node:crypto';
import {fail,text,link,owned} from './suite-validation.js';
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const stamp=o=>hash(JSON.stringify([o.title,o.drive_url,o.status,o.approval_step,new Date(o.updated_at).toISOString()]));
export async function ensureClientApproval(c,order){
 const r=(await c.query('select * from agency_content_reviews where work_order_id=$1 and organization_id=$2 order by id desc limit 1',[order.id,order.organization_id])).rows[0];
 if(r&&r.status!=='revoked'&&(r.status!=='approved'||r.version_stamp!==stamp(order)))fail('Falta la aprobación del cliente para esta versión');
}
const shell=(title,content)=>`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escape(title)} · Scale OS</title><style>:root{--brand:#4D065B;--ink:#251C29;--muted:#746C78;--line:#E8E3EA;--surface:#fff;--canvas:#F7F6F8}*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--canvas);font:16px/1.6 Arial,sans-serif;color:var(--ink)}main{max-width:680px;margin:40px auto;padding:32px;background:var(--surface);border:1px solid var(--line);border-radius:20px}h1{font-size:28px;overflow-wrap:anywhere}p{white-space:pre-wrap;overflow-wrap:anywhere}.muted{color:var(--muted);font-size:13px}input,textarea{display:block;width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;font:inherit;margin:8px 0 20px}button,.button{display:inline-block;padding:12px 18px;border:0;border-radius:8px;background:var(--brand);color:var(--surface);font:inherit;text-decoration:none;margin:8px 8px 8px 0;cursor:pointer}@media(max-width:480px){body{padding:12px}main{margin:12px auto;padding:20px}}</style></head><body><main><p class="muted">REVISIÓN DE CONTENIDO</p><h1>${escape(title)}</h1>${content}</main></body></html>`;
export async function contentReview({req,res,url,db,session,body,send}){
 const pub=url.pathname.match(/^\/review\/([a-f0-9]{64})(?:\/(respond))?$/),route=url.pathname.match(/^\/api\/agency\/work-orders\/(\d+)\/client-review(?:\/(\d+)\/(revoke))?$/);
 if(!pub&&!route)return false;let c,tx=false;
 try{
  const user=pub?null:await session(req);if(!pub&&!user)fail('No autenticado',401);
  if(user&&!['owner','admin','management','production'].includes(user.role))fail('Sin permiso para compartir piezas',403);
  c=await db.connect();await c.query('begin');tx=true;
  if(pub){
   let review=(await c.query('select * from agency_content_reviews where token_hash=$1',[hash(pub[1])])).rows[0];
   if(!review||review.status==='revoked'||new Date(review.expires_at)<new Date())fail('Este enlace venció o fue desactivado. Pedí uno nuevo a tu agencia.',404);
   const order=await owned(c,'agency_work_orders',review.work_order_id,review.organization_id);
   review=(await c.query('select * from agency_content_reviews where id=$1 for update',[review.id])).rows[0];
   if(review.status==='revoked')fail('Este enlace fue desactivado.',404);
   const current=stamp(order)===review.version_stamp;
   if(req.method==='POST'&&pub[2]){
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8000)fail('Respuesta demasiado larga');}
    const form=new URLSearchParams(raw),name=text(form.get('name')||'',120),feedback=text(form.get('feedback')||'',2000),action=form.get('action');
    if(name.length<2||!['approve','changes'].includes(action))fail('Completá tu nombre y elegí una respuesta');
    if(action==='changes'&&feedback.length<5)fail('Contanos qué necesitás cambiar');
    if(review.status!=='pending'||!current)fail('Esta versión ya fue respondida o cambió. Pedí un enlace actualizado.',409);
    await c.query("select set_config('app.current_user','client-link',true),set_config('app.current_ip',$1,true)",[req.socket.remoteAddress||'']);
    await c.query('update agency_content_reviews set status=$1,reviewer_name=$2,feedback=$3,responded_at=now() where id=$4',[action==='approve'?'approved':'changes',name,feedback,review.id]);
    if(action==='changes')await c.query("update agency_work_orders set status='editing',approval_step=0,updated_at=now() where id=$1",[order.id]);
    await c.query('commit');tx=false;res.writeHead(303,{Location:`/review/${pub[1]}`});res.end();return true;
   }
   if(req.method!=='GET'||pub[2])fail('Método no permitido',405);
   const pending=review.status==='pending'&&current;
   const html=shell(review.title,`<p>Revisá la pieza y dejá tu respuesta. El archivo se abre en su servicio de origen.</p><a class="button" href="${escape(review.asset_url)}" target="_blank" rel="noopener noreferrer">Abrir pieza</a>${pending?`<form method="post" action="/review/${pub[1]}/respond"><label>Nombre completo<input name="name" required maxlength="120" autocomplete="name"></label><label>Comentarios o cambios<textarea name="feedback" maxlength="2000" rows="4"></textarea></label><button name="action" value="approve">Aprobar esta versión</button><button name="action" value="changes">Solicitar cambios</button></form>`:`<h2>${escape(review.status==='approved'?'Versión aprobada':review.status==='changes'?'Cambios solicitados':'La pieza fue actualizada')}</h2><p>${escape(review.feedback||'Pedí un nuevo enlace si necesitás revisar otra versión.')}</p>`}<p class="muted">Vence: ${new Date(review.expires_at).toISOString().slice(0,10)}. Quien tenga este enlace puede responder. El nombre declarado no equivale a una firma digital verificada.</p>`);
   await c.query('commit');tx=false;res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);return true;
  }
  await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);
  const order=await owned(c,'agency_work_orders',route[1],user.organization_id);let result;
  if(req.method==='GET'&&!route[2])result={reviews:(await c.query('select id,title,status,expires_at,reviewer_name,feedback,responded_at,created_at from agency_content_reviews where work_order_id=$1 and organization_id=$2 order by id desc',[order.id,user.organization_id])).rows};
  else if(req.method==='POST'&&route[2]){const r=await c.query("update agency_content_reviews set status='revoked' where id=$1 and work_order_id=$2 and organization_id=$3 and status='pending' returning id",[route[2],order.id,user.organization_id]);if(!r.rows.length)fail('No hay una revisión pendiente con ese ID',404);result={ok:true};}
  else if(req.method==='POST'){
   if(order.status!=='approved')fail('Completá primero las aprobaciones internas');const asset=link(order.drive_url);if(!asset)fail('Agregá el enlace de la pieza en sus detalles');
   const token=crypto.randomBytes(32).toString('hex');await c.query("update agency_content_reviews set status='revoked' where work_order_id=$1 and status='pending'",[order.id]);
   const r=await c.query("insert into agency_content_reviews(organization_id,work_order_id,token_hash,title,asset_url,version_stamp,expires_at,created_by_user_id) values($1,$2,$3,$4,$5,$6,now()+interval '7 days',$7) returning id,expires_at",[user.organization_id,order.id,hash(token),order.title,asset,stamp(order),user.id]);result={review:r.rows[0],url:`https://app.scaleparaguay.com/review/${token}`};
  }else fail('Método no permitido',405);
  await c.query('commit');tx=false;send(res,200,result);
 }catch(e){if(tx)await c.query('rollback');console.error(JSON.stringify({event:'content_review_error',status:e.status||500,code:e.code}));if(pub){res.writeHead(e.status||500,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(shell('No pudimos completar la revisión',`<p>${escape(e.status?e.message:'Intentá de nuevo en unos minutos.')}</p>`));}else send(res,e.status||500,{error:e.status?e.message:'No se pudo completar la revisión'});}finally{c?.release();}
 return true;
}
