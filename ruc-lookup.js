import {fail,text} from './suite-validation.js';
export function normalizeRuc(value){
 const clean=String(value??'').trim().replace(/[.\s]/g,'');
 if(!/^\d{3,12}(?:-\d)?$/.test(clean))fail('Ingresá un RUC numérico, con o sin guion y dígito verificador');
 return clean;
}
export function rucRecord(value,requested){
 if(!value||typeof value!=='object'||typeof value.name!=='string'||!value.name.trim())fail('El proveedor no devolvió una ficha válida',502);
 const full=normalizeRuc(value.fullRuc||`${value.ruc}-${value.dv}`);
 if(!full.includes('-')||(requested.includes('-')?full!==requested:full.split('-')[0]!==requested))fail('El RUC recibido no coincide con la consulta',502);
 return {name:text(value.name,160),tax_id:full,tax_state:text(value.state||'',60),source:'https://ruc.sun.com.py',publication_date:text(value.publicationDateText||'',30)};
}
export async function rucLookup({req,res,url,db,session,body,send,fetcher=fetch}){
 if(!['/api/agency/ruc-lookup','/api/agency/clients/from-ruc'].includes(url.pathname))return false;
 let c,tx=false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  if(!['owner','admin','management','sales'].includes(user.role))fail('Sin permiso para gestionar clientes',403);
  if(user.demo_owner_user_id&&url.pathname.endsWith('ruc-lookup'))fail('El Demo no consume consultas reales de RUC. Usá esta función en tu agencia.',403);
  if(req.method!=='POST')fail('Método no permitido',405);
  const b=await body(req),ruc=normalizeRuc(b.ruc);
  c=await db.connect();await c.query('begin');tx=true;
  if(url.pathname.endsWith('from-ruc')){
   if(!ruc.includes('-'))fail('Confirmá el RUC completo con su dígito verificador');
   const name=text(b.name,120),legal=text(b.legal_name,160);if(name.length<2||legal.length<2)fail('Revisá nombre y razón social');
   await c.query('select id from organizations where id=$1 for update',[user.organization_id]);
   const duplicate=await c.query("select id from agency_clients where organization_id=$1 and regexp_replace(coalesce(tax_id,''),'[^0-9]','','g')=$2 limit 1",[user.organization_id,ruc.replace('-','')]);
   if(duplicate.rows.length)fail('Ya existe un cliente con este RUC en tu empresa. Buscalo antes de crear otro.',409);
   await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);
   const client=(await c.query('insert into agency_clients(organization_id,name,legal_name,tax_id) values($1,$2,$3,$4) returning *',[user.organization_id,name,legal,ruc])).rows[0];
   await c.query('commit');tx=false;send(res,201,{client});return true;
  }
  await c.query("insert into scale_ruc_usage(month) values(date_trunc('month',current_date)::date) on conflict do nothing");
  const usage=await c.query("update scale_ruc_usage set used=used+1 where month=date_trunc('month',current_date)::date and used<100 returning used");
  if(!usage.rows.length)fail('Se alcanzó el límite gratuito mensual de consultas. Podés agregar el cliente manualmente.',429);
  await c.query('commit');tx=false;c.release();c=null;
  const response=await fetcher(`https://ruc.sun.com.py/api/ruc/${encodeURIComponent(ruc)}`,{signal:AbortSignal.timeout(12000),headers:{Accept:'application/json'},redirect:'error'});
  if(response.status===404)fail('No encontramos ese RUC. Revisá el número o agregá el cliente manualmente.',404);
  if(response.status===429)fail('El proveedor alcanzó su límite gratuito. Podés agregar el cliente manualmente.',429);
  if(!response.ok)fail('La consulta externa no está disponible. Podés agregar el cliente manualmente.',502);
  const record=rucRecord(await response.json(),ruc);send(res,200,{record,remaining:100-usage.rows[0].used});return true;
 }catch(error){if(tx)await c.query('rollback');console.error(JSON.stringify({event:'ruc_lookup_error',status:error.status||502}));send(res,error.status||502,{error:error.status?error.message:'No se pudo consultar el RUC. Intentá más tarde o agregá el cliente manualmente.'});return true;}finally{c?.release();}
}
