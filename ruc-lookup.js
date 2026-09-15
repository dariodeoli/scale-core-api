import {roleCan} from './permissions.js';
import {fail,text} from './suite-validation.js';

const defaultProviderUrl='https://ruc.sun.com.py/api/ruc';
const numberSetting=(value,fallback,min,max)=>{
 const parsed=Number(value);
 return Number.isInteger(parsed)&&parsed>=min&&parsed<=max?parsed:fallback;
};

export function normalizeRuc(value){
 const clean=String(value??'').trim().replace(/[.\s]/g,'');
 if(!/^\d{3,12}(?:-\d)?$/.test(clean))fail('Ingresá un RUC numérico, con o sin guion y dígito verificador');
 return clean;
}
export function rucDigits(value){
 const raw=String(value??'').trim();
 return raw?normalizeRuc(raw).replace('-',''):null;
}
export function rucLookupConfig(env=process.env){
 const providerUrl=(env.RUC_LOOKUP_PROVIDER_URL||defaultProviderUrl).trim().replace(/\/+$/,'');
 try{const parsed=new URL(providerUrl);if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw Error();}catch{throw Error('RUC_LOOKUP_PROVIDER_URL debe ser una URL HTTPS válida');}
 return {
  providerUrl,
  timeoutMs:numberSetting(env.RUC_LOOKUP_TIMEOUT_MS,12000,1000,30000),
  cacheTtlSeconds:numberSetting(env.RUC_LOOKUP_CACHE_TTL_SECONDS,86400,60,604800),
  noResultTtlSeconds:numberSetting(env.RUC_LOOKUP_NO_RESULT_TTL_SECONDS,3600,60,86400),
  monthlyLimit:numberSetting(env.RUC_LOOKUP_MONTHLY_LIMIT,100,1,100),
 };
}
export function createRucProvider({baseUrl=defaultProviderUrl,fetcher=fetch,timeoutMs=12000}={}){
 const endpoint=String(baseUrl).replace(/\/+$/,'');
 return {name:'configured-ruc-provider',async lookup(ruc){
  let response;
  try{response=await fetcher(`${endpoint}/${encodeURIComponent(ruc)}`,{signal:AbortSignal.timeout(timeoutMs),headers:{Accept:'application/json'},redirect:'error'});}catch{throw Object.assign(Error('Proveedor de RUC no disponible'),{status:503});}
  if(response.status===404)return null;
  if(!response.ok)throw Object.assign(Error('Proveedor de RUC no disponible'),{status:503});
  try{return await response.json();}catch{throw Object.assign(Error('Proveedor de RUC devolvió una respuesta inválida'),{status:503});}
 }};
}
export async function assertUniqueClientRuc(c,organizationId,taxId,exceptClientId=null){
 const digits=rucDigits(taxId);if(!digits)return;
 const params=exceptClientId?[organizationId,digits,exceptClientId]:[organizationId,digits];
 const excluded=exceptClientId?' and id<>$3':'';
 const found=await c.query(`select id,name from agency_clients where organization_id=$1 and regexp_replace(coalesce(tax_id,''),'[^0-9]','','g')=$2${excluded} limit 1`,params);
 if(found.rows.length)fail('Ya existe un cliente con este RUC en tu empresa. Buscalo antes de crear otro.',409);
}
export function rucRecord(value,requested){
 if(!value||typeof value!=='object'||typeof value.name!=='string'||!value.name.trim())fail('El proveedor no devolvió una ficha válida',502);
 const full=normalizeRuc(value.fullRuc||`${value.ruc}-${value.dv}`);
 if(!full.includes('-')||(requested.includes('-')?full!==requested:full.split('-')[0]!==requested))fail('El RUC recibido no coincide con la consulta',502);
 return {name:text(value.name,160),tax_id:full,tax_state:text(value.state||'',60),source:'ruc-provider',publication_date:text(value.publicationDateText||'',30)};
}
const parsedCache=value=>typeof value==='string'?JSON.parse(value):value;
async function cachedRecord(c,ruc){
 const row=(await c.query('select record,no_result from agency_ruc_lookup_cache where lookup_key=$1 and expires_at>now()',[ruc])).rows[0];
 return row?{record:row.no_result?null:parsedCache(row.record),cached:true}:null;
}
async function writeCache(c,ruc,record,seconds){
 await c.query(`insert into agency_ruc_lookup_cache(lookup_key,record,no_result,expires_at,updated_at)
  values($1,$2::jsonb,$3,now()+($4::text||' seconds')::interval,now())
  on conflict(lookup_key) do update set record=excluded.record,no_result=excluded.no_result,expires_at=excluded.expires_at,updated_at=excluded.updated_at`,[ruc,record?JSON.stringify(record):null,!record,seconds]);
}
async function consumeQuota(c,limit){
 await c.query("insert into scale_ruc_usage(month) values(date_trunc('month',current_date)::date) on conflict do nothing");
 const usage=await c.query("update scale_ruc_usage set used=used+1 where month=date_trunc('month',current_date)::date and used<$1 returning used",[limit]);
 if(!usage.rows.length)fail('Se alcanzó el límite mensual de consultas. Podés agregar el cliente manualmente.',429);
 return Number(usage.rows[0].used);
}
async function lookupCachedOrProvider({db,ruc,provider,config,force=false}){
 let c=await db.connect();
 try{
  if(!force){const cached=await cachedRecord(c,ruc);if(cached)return {...cached,remaining:null};}
  await c.query('begin');const used=await consumeQuota(c,config.monthlyLimit);await c.query('commit');
  let raw;
  try{raw=await provider.lookup(ruc);}catch{throw Object.assign(Error('La consulta externa no está disponible. Podés agregar el cliente manualmente.'),{status:503});}
  let record;
  try{record=raw?rucRecord(raw,ruc):null;}catch{throw Object.assign(Error('La consulta externa devolvió una respuesta inválida. Podés agregar el cliente manualmente.'),{status:503});}
  await writeCache(c,ruc,record,record?config.cacheTtlSeconds:config.noResultTtlSeconds);
  return {record,cached:false,remaining:config.monthlyLimit-used};
 }catch(error){try{await c.query('rollback');}catch{}throw error;}finally{c.release();}
}
export async function rucLookup({req,res,url,db,session,body,send,provider,config,fetcher=fetch}){
 if(!['/api/agency/ruc-lookup','/api/agency/clients/from-ruc'].includes(url.pathname)&&!/^\/api\/agency\/clients\/\d+\/ruc-refresh$/.test(url.pathname))return false;
 let c,tx=false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  if(!roleCan(user,'clients.manage'))fail('Sin permiso para gestionar clientes',403);
  if(user.demo_owner_user_id)fail('El Demo no consume consultas reales de RUC. Usá esta función en tu agencia.',403);
  if(req.method!=='POST')fail('Método no permitido',405);
  const b=await body(req);
  const settings=config||rucLookupConfig();
  const service=provider||createRucProvider({baseUrl:settings.providerUrl,fetcher,timeoutMs:settings.timeoutMs});
  const refresh=url.pathname.match(/^\/api\/agency\/clients\/(\d+)\/ruc-refresh$/);
  if(url.pathname.endsWith('from-ruc')){
   const ruc=normalizeRuc(b.ruc);if(!ruc.includes('-'))fail('Confirmá el RUC completo con su dígito verificador');
   const name=text(b.name,120),legal=text(b.legal_name,160);if(name.length<2||legal.length<2)fail('Revisá nombre y razón social');
   c=await db.connect();await c.query('begin');tx=true;
   await c.query('select id from organizations where id=$1 for update',[user.organization_id]);
   await assertUniqueClientRuc(c,user.organization_id,ruc);
   await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);
   const client=(await c.query('insert into agency_clients(organization_id,name,legal_name,tax_id) values($1,$2,$3,$4) returning *',[user.organization_id,name,legal,ruc])).rows[0];
   await c.query('commit');tx=false;send(res,201,{client});return true;
  }
  if(refresh){
   c=await db.connect();const client=(await c.query('select * from agency_clients where id=$1 and organization_id=$2',[refresh[1],user.organization_id])).rows[0];
   c.release();c=null;
   if(!client)fail('Cliente no encontrado',404);
   const ruc=normalizeRuc(client.tax_id);if(!ruc.includes('-'))fail('El cliente debe tener un RUC completo con dígito verificador para actualizarse');
   const found=await lookupCachedOrProvider({db,ruc,provider:service,config:settings,force:true});
   if(!found.record){send(res,200,{client,record:null,updated:false,remaining:found.remaining});return true;}
   if(b.apply!==true){send(res,200,{client,record:found.record,updated:false,remaining:found.remaining});return true;}
   c=await db.connect();await c.query('begin');tx=true;
   await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);
   const updated=(await c.query(`update agency_clients set ruc_legal_name=$1,ruc_tax_state=$2,ruc_source=$3,ruc_refreshed_at=now(),updated_at=now()
    where id=$4 and organization_id=$5 returning *`,[found.record.name,found.record.tax_state,found.record.source,client.id,user.organization_id])).rows[0];
   await c.query('commit');tx=false;send(res,200,{client:updated,record:found.record,updated:true,remaining:found.remaining});return true;
  }
  const ruc=normalizeRuc(b.ruc);
  const found=await lookupCachedOrProvider({db,ruc,provider:service,config:settings});
  send(res,200,{record:found.record,cached:found.cached,remaining:found.remaining});return true;
 }catch(error){if(tx)await c.query('rollback');console.error(JSON.stringify({event:'ruc_lookup_error',status:error.status||503}));send(res,error.status||503,{error:error.status?error.message:'No se pudo consultar el RUC. Intentá más tarde o agregá el cliente manualmente.'});return true;}finally{c?.release();}
}
