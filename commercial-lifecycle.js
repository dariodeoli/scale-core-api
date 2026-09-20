import {currencies} from './currencies.js';
import {civilDate} from './business-time.js';
import {roleCan} from './permissions.js';
import {amount,date,fail,id,option,text} from './suite-validation.js';



const discountTypes=['none','percent','fixed'];
const currentTerm=`effective_from<=current_date and (effective_until is null or effective_until>=current_date)`;
// Fecha civil del negocio: un `date` no puede correrse por leerlo en UTC.
const sqlDate=value=>civilDate(value)??String(value??'').slice(0,10);

function requiredText(value,label,max){const valueText=text(value??'',max);if(!valueText)fail(`${label} es obligatorio`);return valueText;}
function list(value,label){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>100)fail(`${label} debe contener entre 0 y 100 elementos`);
 return value.map(entry=>requiredText(entry,label,300));
}
function discount(input){
 const type=option(input.discount_type??input.discountType??'none',discountTypes);
 const value=amount(input.discount_value??input.discountValue??0);
 if(type==='none'&&value!==0)fail('Un descuento inexistente no puede tener valor');
 if(type==='percent'&&(value<=0||value>100))fail('El descuento porcentual debe estar entre 0 y 100');
 if(type==='fixed'&&value<=0)fail('El descuento fijo debe ser mayor a cero');
 return {type,value,terms:text(input.discount_terms??input.discountTerms??'',2000)};
}
function termInput(input,{activationDate=null,minimumEffectiveFrom=null,activationRequired=true}={}){
 const activation=date(input.activation_date??input.activationDate??activationDate);
 if(!activation&&activationRequired)fail('La fecha de activación es obligatoria');
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
function termValues(term){return [term.activation,term.effective,term.planName,term.planVersion,term.price,term.currency,term.discountType,term.discountValue,term.discountTerms,JSON.stringify(term.extras),JSON.stringify(term.deliverables),term.effective];}
// starts_on mirrors the lifecycle effective date: the reconciliation migration
// made it required and the forecast/commissions contract reads it.
async function insertTerm(connection,organization,clientId,term){
 return (await connection.query('insert into agency_client_commercial_terms(organization_id,client_id,activation_date,effective_from,plan_name,plan_version,monthly_price,currency,discount_type,discount_value,discount_terms,extras,deliverables,starts_on) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *',[organization,clientId,...termValues(term)])).rows[0];
}
async function closeTerm(connection,organization,clientId,prior,effectiveUntil,version){
 // ends_on mirrors effective_until: the forecast contract filters by ends_on
 // and a closed term must stop counting there too.
 return (await connection.query('update agency_client_commercial_terms set effective_until=$1,ends_on=$1,closed_at=now(),version=version+1 where id=$2 and organization_id=$3 and client_id=$4 and version=$5 returning *',[effectiveUntil,prior.id,organization,clientId,version])).rows[0];
}
async function openTerm(connection,organization,clientId){
 return (await connection.query('select * from agency_client_commercial_terms where organization_id=$1 and client_id=$2 and effective_until is null for update',[organization,clientId])).rows[0]||null;
}
async function archivedClient(connection,organization,clientId){
 return (await connection.query("select 1 from agency_archived_records where organization_id=$1 and kind='clients' and record_id=$2",[organization,clientId])).rows.length>0;
}
// Client ficha contract (scale-os app/client-commercial-lifecycle.tsx): one
// camelCase amendment list per client, versioned by the latest stored row.
const uiAmendment=row=>({
 id:String(row.id),
 effectiveOn:row.effective_from?sqlDate(row.effective_from):row.starts_on?sqlDate(row.starts_on):'',
 activationDate:row.activation_date?sqlDate(row.activation_date):null,
 planName:row.ui_plan_name||'',
 planVersionSnapshot:row.plan_version||'',
 monthlyPrice:row.ui_monthly_price===null||row.ui_monthly_price===undefined?'0':String(row.ui_monthly_price),
 currency:String(row.currency||''),
 discountType:discountTypes.includes(row.discount_type)?row.discount_type:'none',
 discountValue:row.discount_type!=='none'&&row.discount_value!==null&&row.discount_value!==undefined?String(Number(row.discount_value)):null,
 discountTerms:row.discount_terms||null,
 extrasDeliverables:Array.isArray(row.extras)&&row.extras.length?row.extras.join(' · '):null,
 createdAt:row.created_at instanceof Date?row.created_at.toISOString():String(row.created_at||''),
});
async function uiHistory(connection,organization,clientId){
 // Terms written by the reporting contract carry starts_on/recurring_amount
 // instead of the lifecycle columns; both are projected into the same list.
 const rows=(await connection.query(`select t.*,coalesce(t.plan_name,p.name) as ui_plan_name,coalesce(t.monthly_price,t.recurring_amount) as ui_monthly_price from agency_client_commercial_terms t left join agency_plans p on p.organization_id=t.organization_id and p.id=t.plan_id where t.organization_id=$1 and t.client_id=$2 order by coalesce(t.effective_from,t.starts_on) asc nulls last,t.id asc`,[organization,clientId])).rows;
 const version=(await connection.query('select coalesce(max(id),0)::text as version from agency_client_commercial_terms where organization_id=$1 and client_id=$2',[organization,clientId])).rows[0].version;
 return {clientId:String(clientId),version,archived:await archivedClient(connection,organization,clientId),amendments:rows.map(uiAmendment)};
}
function uiTermInput(input){
 const extras=typeof input.extrasDeliverables==='string'?input.extrasDeliverables.trim():'';
 if(extras.length>300)fail('Los extras y entregables no pueden superar los 300 caracteres');
 return {...input,effective_from:input.effectiveOn,plan_version:input.planVersionSnapshot,extras:extras?[extras]:[],deliverables:[]};
}
async function client(connection,organization,clientId){
 const row=(await connection.query('select id,name,active,lifecycle_status from agency_clients where id=$1 and organization_id=$2 for update',[id(clientId),organization])).rows[0];
 if(!row)fail('Cliente no encontrado',404);return row;
}
async function terms(connection,organization,clientId){return (await connection.query('select * from agency_client_commercial_terms where organization_id=$1 and client_id=$2 order by effective_from desc,id desc',[organization,clientId])).rows;}
export async function commercialProfile(connection,organization,clientId){
 const rows=await terms(connection,organization,clientId);
 return {current_term:rows.find(term=>term.effective_until===null)||null,terms:rows};
}
async function controlCenter(connection,organization,financial){
 const activeClients=(await connection.query("select count(*)::int as count from agency_clients where organization_id=$1 and active=true and coalesce(lifecycle_status,'active')='active'",[organization])).rows[0].count;
 // A custom stage counts as closed only through its kind; legacy slugs keep the
 // literal fallback so metrics never depend on the stage editor.
 const activeProspects=(await connection.query("select count(*)::int as count from agency_leads l where l.organization_id=$1 and l.stage not in ('won','lost') and not exists(select 1 from agency_pipeline_stages s where s.organization_id=l.organization_id and s.slug=l.stage and s.kind in ('won','lost'))",[organization])).rows[0].count;
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
 // Superficie vigente: el control center y la ficha del cliente. La ruta legacy
 // /api/agency/commercial/clients/... se retiró en el issue #21: ningún
 // consumidor del front la usaba (solo su propio test) y el flujo de ficha
 // (lectura versionada + enmiendas) ya cubre el alta y la edición del término.
 const route=url.pathname.match(/^\/api\/agency\/control-center$/);
 const uiRoute=url.pathname.match(/^\/api\/agency\/clients\/(\d+)\/commercial-lifecycle(?:\/amendments)?$/);
 if(!route&&!uiRoute)return false;
 let connection,transaction=false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  if(uiRoute){
   const amendments=url.pathname.endsWith('/amendments');
   if(!roleCan(user,amendments?'commercial-terms.manage':'billing.view'))fail('Tu rol no permite esta operación',403);
   if(amendments?req.method!=='POST':req.method!=='GET')fail('Método no permitido',405);
   connection=await db.connect();await connection.query('begin');transaction=true;
   const organization=user.organization_id,clientId=id(uiRoute[1]);
   await client(connection,organization,clientId);
   let result,status=200;
   if(amendments){
    if(await archivedClient(connection,organization,clientId))fail('Restaurá el cliente antes de editarlo',409);
    const input=await body(req),expected=String(input.expectedVersion??'');
    if(!/^\d{1,19}$/.test(expected))fail('La versión esperada es obligatoria');
    const current=await uiHistory(connection,organization,clientId);
    if(current.version!==expected)fail('El cliente cambió. Actualizá los datos antes de guardar.',409);
    const prior=await openTerm(connection,organization,clientId);
    const term=termInput(uiTermInput(input),{activationDate:prior?prior.activation_date:null,minimumEffectiveFrom:prior?(prior.effective_from||prior.starts_on||null):null,activationRequired:!prior});
    if(prior&&term.activation!==sqlDate(prior.activation_date))fail('La fecha de activación no cambia en una enmienda',409);
    if(prior){
     const closedOn=new Date(`${term.effective}T12:00:00Z`);closedOn.setUTCDate(closedOn.getUTCDate()-1);
     const effectiveUntil=closedOn.toISOString().slice(0,10);
     if(prior.effective_from&&effectiveUntil<sqlDate(prior.effective_from))fail('La enmienda debe comenzar después del término vigente',409);
     const closed=await closeTerm(connection,organization,clientId,prior,effectiveUntil,prior.version);
     if(!closed)fail('El término comercial cambió. Recargá antes de guardar.',409);
    }
    await insertTerm(connection,organization,clientId,term);
    result={commercial:await uiHistory(connection,organization,clientId)};status=201;
   }else result={commercial:await uiHistory(connection,organization,clientId)};
   await connection.query('commit');transaction=false;send(res,status,result);return true;
  }
  if(!roleCan(user,'commercial.manage'))fail('Tu rol no permite esta operación',403);
  if(req.method!=='GET')fail('Método no permitido',405);
  connection=await db.connect();await connection.query('begin');transaction=true;
  const result=await controlCenter(connection,user.organization_id,roleCan(user,'finance.view'));
  await connection.query('commit');transaction=false;send(res,200,result);
 }catch(error){
  if(transaction)await connection.query('rollback');
  const conflict=['23505','23514','40001','40P01'].includes(error.code);
  send(res,conflict?409:error.status||500,{error:conflict?'El término comercial entró en conflicto. Recargá antes de guardar.':error.status?error.message:'No se pudo completar el ciclo comercial'});
 }finally{connection?.release();}
 return true;
}
