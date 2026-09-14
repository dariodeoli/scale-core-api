import {currencies} from './currencies.js';
import {amount,date,fail,id,option,text} from './suite-validation.js';

const commercialRoles=['owner','admin','management','finance','sales'];
const financialRoles=['owner','admin','finance'];
const discountTypes=['none','percent','fixed'];
const currentTerm=`effective_from<=current_date and (effective_until is null or effective_until>=current_date)`;
const sqlDate=value=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);

function requiredText(value,label,max){const valueText=text(value??'',max);if(!valueText)fail(`${label} es obligatorio`);return valueText;}
function list(value,label){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>100)fail(`${label} debe contener entre 0 y 100 elementos`);
 return value.map(entry=>requiredText(entry,label,300));
}
function expectedVersion(input){
 const raw=input.expected_version??input.expectedVersion;
 const value=Number(raw);
 if(!Number.isSafeInteger(value)||value<1)fail('La versión esperada es obligatoria');
 return value;
}
function discount(input){
 const type=option(input.discount_type??input.discountType??'none',discountTypes);
 const value=amount(input.discount_value??input.discountValue??0);
 if(type==='none'&&value!==0)fail('Un descuento inexistente no puede tener valor');
 if(type==='percent'&&(value<=0||value>100))fail('El descuento porcentual debe estar entre 0 y 100');
 if(type==='fixed'&&value<=0)fail('El descuento fijo debe ser mayor a cero');
 return {type,value,terms:text(input.discount_terms??input.discountTerms??'',2000)};
}
function termInput(input,{activationDate=null,minimumEffectiveFrom=null}={}){
 const activation=date(input.activation_date??input.activationDate??activationDate);
 if(!activation)fail('La fecha de activación es obligatoria');
 const effective=date(input.effective_from??input.effectiveFrom??activation);
 if(!effective)fail('La fecha de vigencia es obligatoria');
 if(minimumEffectiveFrom&&effective<minimumEffectiveFrom)fail('La enmienda no puede preceder el término vigente',409);
 const price=amount(input.monthly_price??input.monthlyPrice);
 if(price<=0)fail('El precio mensual debe ser mayor a cero');
 const {type,value,terms}=discount(input);
 return {
  activation,effective,planName:requiredText(input.plan_name??input.planName,'El plan',160),planVersion:requiredText(input.plan_version??input.planVersion,'La versión del plan',80),
  price,currency:option(input.currency,currencies),discountType:type,discountValue:value,discountTerms:terms,
  extras:list(input.extras??input.custom_extras??input.customExtras,'Los extras'),deliverables:list(input.deliverables,'Los entregables')
 };
}
function termValues(term){return [term.activation,term.effective,term.planName,term.planVersion,term.price,term.currency,term.discountType,term.discountValue,term.discountTerms,JSON.stringify(term.extras),JSON.stringify(term.deliverables)];}
async function client(connection,organization,clientId){
 const row=(await connection.query('select id,name,active,lifecycle_status from agency_clients where id=$1 and organization_id=$2 for update',[id(clientId),organization])).rows[0];
 if(!row)fail('Cliente no encontrado',404);return row;
}
async function terms(connection,organization,clientId){return (await connection.query('select * from agency_client_commercial_terms where organization_id=$1 and client_id=$2 order by effective_from desc,id desc',[organization,clientId])).rows;}
export async function commercialProfile(connection,organization,clientId){
 const rows=await terms(connection,organization,clientId);
 return {current_term:rows.find(term=>term.effective_until===null)||null,terms:rows};
}
async function ltv(connection,organization,clientId){
 return (await connection.query(`select i.currency,coalesce(sum(case when r.id is null then p.amount else -p.amount end),0)::text as net_collected
  from agency_payments p join agency_invoices i on i.id=p.invoice_id and i.organization_id=p.organization_id
  left join agency_payment_reversals r on r.payment_id=p.id and r.organization_id=p.organization_id
  where p.organization_id=$1 and i.client_id=$2 group by i.currency order by i.currency`,[organization,clientId])).rows;
}
async function controlCenter(connection,organization,financial){
 const activeClients=(await connection.query("select count(*)::int as count from agency_clients where organization_id=$1 and active=true and coalesce(lifecycle_status,'active')='active'",[organization])).rows[0].count;
 const activeProspects=(await connection.query("select count(*)::int as count from agency_leads where organization_id=$1 and stage not in ('won','lost')",[organization])).rows[0].count;
 const contractedBilling=financial?(await connection.query(`select currency,round(sum(case discount_type when 'percent' then monthly_price*(1-discount_value/100) when 'fixed' then greatest(monthly_price-discount_value,0) else monthly_price end),2)::text as net_monthly
  from agency_client_commercial_terms where organization_id=$1 and ${currentTerm} group by currency order by currency`,[organization])).rows:null;
 return {
  active_clients:activeClients,
  active_prospects:activeProspects,
  contracted_billing:financial?{available:true,records:contractedBilling,definition:'Importe mensual contratado neto de descuentos de términos comerciales vigentes; no convierte ni combina monedas.'}:{available:false,reason:'permission'},
  forecast:{separate:true,endpoint:'/api/agency/forecast',definition:'El pronóstico conserva sus propios criterios de facturas emitidas y presupuestos aceptados; no se mezcla con la facturación contratada.'}
 };
}
export async function commercialLifecycle({req,res,url,db,session,body,send}){
 const route=url.pathname.match(/^\/api\/agency\/(?:commercial\/clients\/(\d+)(?:\/terms(?:\/(\d+)\/amend)?)?|control-center)$/);
 if(!route)return false;
 let connection,transaction=false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  const [,rawClientId,rawTermId]=route;
  if(!commercialRoles.includes(user.role))fail('Tu rol no permite esta operación',403);
  if(!['GET','POST'].includes(req.method))fail('Método no permitido',405);
  connection=await db.connect();await connection.query('begin');transaction=true;
  const organization=user.organization_id;
  let result,status=200;
  if(url.pathname==='/api/agency/control-center'){
   if(req.method!=='GET')fail('Método no permitido',405);
   result=await controlCenter(connection,organization,financialRoles.includes(user.role));
  }else{
   const clientId=id(rawClientId);
   const requestedTermId=rawTermId?id(rawTermId):null;
   if(req.method==='GET'){
    if(requestedTermId)fail('Método no permitido',405);
    const record=await client(connection,organization,clientId);
    result={client:record,...await commercialProfile(connection,organization,clientId)};
    result.ltv=financialRoles.includes(user.role)?{available:true,records:await ltv(connection,organization,clientId)}:{available:false,reason:'permission'};
   }else if(!requestedTermId){
    const existing=(await connection.query('select id from agency_client_commercial_terms where organization_id=$1 and client_id=$2 and effective_until is null for update',[organization,clientId])).rows[0];
    if(existing)fail('El cliente ya tiene un término comercial vigente; registrá una enmienda',409);
    await client(connection,organization,clientId);
    const term=termInput(await body(req));
    const saved=(await connection.query('insert into agency_client_commercial_terms(organization_id,client_id,activation_date,effective_from,plan_name,plan_version,monthly_price,currency,discount_type,discount_value,discount_terms,extras,deliverables) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *',[organization,clientId,...termValues(term)])).rows[0];
    result={term:saved};status=201;
   }else{
    const input=await body(req),version=expectedVersion(input);
    const prior=(await connection.query('select * from agency_client_commercial_terms where id=$1 and organization_id=$2 and client_id=$3 for update',[requestedTermId,organization,clientId])).rows[0];
    if(!prior)fail('Término comercial no encontrado',404);
    if(prior.effective_until!==null||prior.version!==version)fail('El término comercial cambió. Recargá antes de guardar.',409);
    const term=termInput(input,{activationDate:prior.activation_date,minimumEffectiveFrom:prior.effective_from});
    if(term.activation!==sqlDate(prior.activation_date))fail('La fecha de activación no cambia en una enmienda',409);
    const closedOn=new Date(`${term.effective}T12:00:00Z`);closedOn.setUTCDate(closedOn.getUTCDate()-1);
    const effectiveUntil=closedOn.toISOString().slice(0,10);
    if(effectiveUntil<sqlDate(prior.effective_from))fail('La enmienda debe comenzar después del término vigente',409);
    const closed=(await connection.query('update agency_client_commercial_terms set effective_until=$1,closed_at=now(),version=version+1 where id=$2 and organization_id=$3 and client_id=$4 and version=$5 returning *',[effectiveUntil,prior.id,organization,clientId,version])).rows[0];
    if(!closed)fail('El término comercial cambió. Recargá antes de guardar.',409);
    const saved=(await connection.query('insert into agency_client_commercial_terms(organization_id,client_id,activation_date,effective_from,plan_name,plan_version,monthly_price,currency,discount_type,discount_value,discount_terms,extras,deliverables) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *',[organization,clientId,...termValues(term)])).rows[0];
    result={prior_term:closed,term:saved};status=201;
   }
  }
  await connection.query('commit');transaction=false;send(res,status,result);
 }catch(error){
  if(transaction)await connection.query('rollback');
  const conflict=['23505','23514','40001','40P01'].includes(error.code);
  send(res,conflict?409:error.status||500,{error:conflict?'El término comercial entró en conflicto. Recargá antes de guardar.':error.status?error.message:'No se pudo completar el ciclo comercial'});
 }finally{connection?.release();}
 return true;
}
