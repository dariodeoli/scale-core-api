import {forecastMonth,wholeMoney} from './forecast.js';
import {option} from './suite-validation.js';
import {roleCan} from './permissions.js';
import {currencies} from './currencies.js';

const timezone='America/Asuncion';
const kinds=['unknown','company','professional','individual','other'];
const termFields=['planId','recurringAmount','currency','startsOn','endsOn','invoiceRequired','commissionRecipientId','commissionMode','commissionValue','cadence','intervalMonths'];
const expenseFields=['cadence','effectiveMonth','category','amount','currency','note','kind'];
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const dateString=value=>value instanceof Date?value.toISOString().slice(0,10):value;
function id(value,label='Identificador') {
 if(!['string','number'].includes(typeof value)||!/^[1-9]\d{0,18}$/.test(String(value))||BigInt(value)>9223372036854775807n)fail(`${label} inválido`);
 return String(value);
}
function wholeAmount(value,label='Importe') {
 const raw=typeof value==='string'?value.trim():value;
 if((typeof raw!=='number'&&typeof raw!=='string')||(typeof raw==='string'&&!/^\d+$/.test(raw)))fail(`${label} debe ser un entero positivo`);
 const amount=Number(raw);
 if(!Number.isSafeInteger(amount)||amount<=0||amount>999999999999)fail(`${label} debe ser un entero positivo`);
 return amount;
}
function requiredDate(value,label) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail(`${label} inválida`);
 return value;
}
function optionalDate(value,label) {
 if(value===null||value===''||value===undefined)return null;
 return requiredDate(value,label);
}
const monthDate=value=>`${forecastMonth(value)}-01`;
const validateFields=(input,fields,label)=>{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.includes(key)))fail(`Campos de ${label} inválidos`);
};
const projectMoney=(record,fields)=>Object.fromEntries(Object.entries(record).map(([key,value])=>[key,fields.includes(key)&&value!==null?wholeMoney(value):value]));
export function reportingPeriod(month=null,months='12',now=new Date()) {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit'}).formatToParts(now);
 const current=`${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}`;
 month=month??current;months=months??'12';
 if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<'1900-01'||month>current)fail('Elegí un mes válido, no posterior al mes actual de Asunción');
 if(!/^(?:[1-9]|1\d|2[0-4])$/.test(String(months)))fail('months debe estar entre 1 y 24');
 return {month,months:Number(months)};
}

// One statement gives clients, payments and invoices the same MVCC snapshot.
export async function agencyReport(db,organizationId,options={},now=new Date()) {
 const {month,months}=reportingPeriod(options.month,options.months,now);
 const {rows}=await db.query(`with
 context as (select $1::bigint org,$2::date selected,$3::int n,$4::timestamptz as_of,$5::text tz),
 coverage as (select history_since from agency_reporting_coverage,context where organization_id=org),
 periods as (select d::date start_on,(d+interval '1 month')::date end_on,
  d at time zone tz start_at,(d+interval '1 month') at time zone tz end_at,as_of,tz,
  least((d+interval '1 month')::date-1,(as_of at time zone tz)::date) snapshot_on
  from context cross join lateral generate_series(selected::timestamp-(n-1)*interval '1 month',selected::timestamp,interval '1 month') d),
 events as (select e.*,e.active and e.lifecycle_status='active' and not e.archived as is_active,
  lag(e.active and e.lifecycle_status='active' and not e.archived) over(partition by e.client_id order by e.event_at,e.id) as was_active
  from agency_client_reporting_events e,context where e.organization_id=org and e.event_at<=as_of),
 snapshots as (select distinct on(p.start_on,e.client_id) p.start_on,e.* from periods p join events e on e.event_at<p.end_at order by p.start_on,e.client_id,e.event_at desc,e.id desc),
 openings as (select distinct on(p.start_on,e.client_id) p.start_on,e.* from periods p join events e on e.event_at<p.start_at order by p.start_on,e.client_id,e.event_at desc,e.id desc),
 invoices as (select p.start_on,i.currency,sum(i.total) invoiced,count(*)::int invoice_count,count(distinct i.client_id)::int billed_clients
  from periods p join agency_invoices i on i.issued_on>=p.start_on and i.issued_on<=p.snapshot_on
  cross join context where i.organization_id=org and i.status in ('issued','partial','paid','overdue') group by p.start_on,i.currency),
 movements as (
  select p.received_on booked_on,a.currency,p.amount from agency_payments p join bank_accounts a on a.id=p.account_id and a.organization_id=p.organization_id
  cross join context where p.organization_id=org
  union all
  select r.reversed_on,a.currency,-p.amount from agency_payment_reversals r join agency_payments p on p.id=r.payment_id and p.organization_id=r.organization_id
  join bank_accounts a on a.id=p.account_id and a.organization_id=p.organization_id cross join context where r.organization_id=org),
 receipts as (select p.start_on,m.currency,sum(m.amount) collected from periods p join movements m on m.booked_on>=p.start_on and m.booked_on<=p.snapshot_on group by p.start_on,m.currency),
 financial as (select coalesce(i.start_on,r.start_on) start_on,coalesce(i.currency,r.currency) currency,
  coalesce(i.invoiced,0)::text invoiced,coalesce(r.collected,0)::text collected,coalesce(i.invoice_count,0) invoice_count,coalesce(i.billed_clients,0) billed_clients,
  round(i.invoiced/nullif(i.invoice_count,0),2)::text average_ticket,round(i.invoiced/nullif(i.billed_clients,0),2)::text average_revenue_per_client
  from invoices i full join receipts r on i.start_on=r.start_on and i.currency=r.currency)
 select p.start_on::text as month,
  p.end_at>p.as_of or c.history_since>p.start_at or c.history_since is null as partial,
  case when c.history_since<p.end_at and c.history_since<=p.as_of then jsonb_build_object(
   'active',(select count(*) from snapshots s where s.start_on=p.start_on and s.is_active),
   'added',case when c.history_since<=p.start_at then (select count(distinct e.client_id) from events e where e.event_at>=p.start_at and e.event_at<p.end_at and e.event_kind='created' and not exists(select 1 from events earlier where earlier.client_id=e.client_id and earlier.event_kind in ('created','observed') and row(earlier.event_at,earlier.id)<row(e.event_at,e.id))) end,
   'lost',case when c.history_since<=p.start_at then (select count(distinct e.client_id) from events e where e.event_at>=p.start_at and e.event_at<p.end_at and e.was_active and not e.is_active) end,
   'retentionPercent',case when c.history_since<=p.start_at then (select round(100.0*count(*) filter(where s.is_active)/nullif(count(*),0),2) from openings o left join snapshots s on s.start_on=o.start_on and s.client_id=o.client_id where o.start_on=p.start_on and o.is_active) end,
   'averageTenureDays',(select round(avg(p.snapshot_on-s.relationship_started_on),2) from snapshots s where s.start_on=p.start_on and s.is_active and s.relationship_started_on<=p.snapshot_on),
   'tenureKnown',(select count(*) from snapshots s where s.start_on=p.start_on and s.is_active and s.relationship_started_on<=p.snapshot_on),
   'types',coalesce((select jsonb_agg(jsonb_build_object('kind',k.customer_kind,'count',k.n) order by k.n desc,k.customer_kind) from (select customer_kind,count(*) n from snapshots s where s.start_on=p.start_on and s.is_active group by customer_kind) k),'[]'::jsonb),
   'plans',coalesce((select jsonb_agg(jsonb_build_object('planId',k.service_plan_id::text,'name',coalesce(k.name,'Sin plan'),'count',k.n) order by k.n desc,k.service_plan_id nulls last) from (select service_plan_id,(array_agg(service_plan_name order by event_at desc,id desc))[1] name,count(*) n from snapshots s where s.start_on=p.start_on and s.is_active group by service_plan_id) k),'[]'::jsonb)
  ) else jsonb_build_object('active',null,'added',null,'lost',null,'retentionPercent',null,'averageTenureDays',null,'tenureKnown',0,'types','[]'::jsonb,'plans','[]'::jsonb) end clients,
  coalesce((select jsonb_agg(jsonb_build_object('currency',f.currency,'invoiced',f.invoiced,'collected',f.collected,'invoiceCount',f.invoice_count,'billedClients',f.billed_clients,'averageTicket',f.average_ticket,'averageRevenuePerClient',f.average_revenue_per_client) order by f.currency) from financial f where f.start_on=p.start_on),'[]'::jsonb) financial,
  c.history_since
 from periods p left join coverage c on true order by p.start_on`,[organizationId,`${month}-01`,months,now.toISOString(),timezone]);
 return {asOf:now.toISOString(),month,historySince:rows[0]?.history_since?new Date(rows[0].history_since).toISOString():null,
  months:rows.map(r=>({month:r.month.slice(0,7),isPartial:r.partial,clients:r.clients,
   financial:r.financial.map(item=>projectMoney(item,['invoiced','collected','averageTicket','averageRevenuePerClient']))}))};
}

async function authorize(db,user,capability) {
 if(!user)fail('No autenticado',401);
 if(!roleCan(user,capability))fail('Tu rol no permite esta operación',403);
 const member=(await db.query('select m.role from organization_members m join organizations o on o.id=m.organization_id where m.user_id=$1 and m.organization_id=$2 and m.active and m.removed_at is null and o.active',[user.id,user.organization_id])).rows[0];
 if(!member||!roleCan({role:member.role,capabilities:user.capabilities},capability))fail('Sin acceso a esta empresa',403);
}
async function metadata(db,org,id) {
 const row=(await db.query(`select c.id::text,c.customer_kind,c.service_plan_id::text,c.relationship_started_on::text,c.reporting_version::text,c.updated_at,
  exists(select 1 from agency_archived_records a where a.organization_id=c.organization_id and a.kind='clients' and a.record_id=c.id) archived
  from agency_clients c where c.organization_id=$1 and c.id=$2`,[org,id])).rows[0];
 if(!row)fail('Cliente no encontrado',404);
 const plans=(await db.query("select p.id::text,p.name from agency_plans p where p.organization_id=$1 and p.active and not exists(select 1 from agency_archived_records a where a.organization_id=p.organization_id and a.kind='plans' and a.record_id=p.id) order by p.name,p.id",[org])).rows;
 return {reporting:{clientId:row.id,customerKind:row.customer_kind,servicePlanId:row.service_plan_id,relationshipStartedOn:dateString(row.relationship_started_on),version:row.reporting_version,updatedAt:new Date(row.updated_at).toISOString(),archived:row.archived},plans};
}
async function commercialTerms(db,org,id) {
 const client=(await db.query(`select c.id::text,exists(select 1 from agency_archived_records a where a.organization_id=c.organization_id and a.kind='clients' and a.record_id=c.id) archived
  from agency_clients c where c.organization_id=$1 and c.id=$2`,[org,id])).rows[0];
 if(!client)fail('Cliente no encontrado',404);
  // Rows written by the commercial lifecycle carry the plan snapshot instead of a
  // catalog plan (plan_id null, plan_name/plan_version/monthly_price set). They are
  // served with the same contract: the plan name from the snapshot, no catalog id,
  // and the recurring amount net of discounts (the same projection the forecast and
  // the control center use).
  const terms=(await db.query(`select t.client_id::text as "clientId",coalesce(t.plan_id::text,'') as "planId",coalesce(t.plan_name,p.name,'') as "planName",
  coalesce(t.recurring_amount,round(case when t.discount_type='percent' then t.monthly_price*(1-t.discount_value/100) when t.discount_type='fixed' then greatest(t.monthly_price-t.discount_value,0) else t.monthly_price end)::bigint)::text as "recurringAmount",t.currency,
  t.starts_on::text as "startsOn",t.ends_on::text as "endsOn",t.cadence,t.interval_months as "intervalMonths",t.invoice_required as "invoiceRequired",t.commission_recipient_id::text as "commissionRecipientId",c.full_name as "commissionRecipientName",
  coalesce(t.commission_mode,'none') as "commissionMode",t.commission_value::text as "commissionValue",t.updated_at as "updatedAt"
  from agency_client_commercial_terms t left join agency_plans p on p.organization_id=t.organization_id and p.id=t.plan_id
  left join agency_collaborators c on c.organization_id=t.organization_id and c.id=t.commission_recipient_id
  where t.organization_id=$1 and t.client_id=$2 and t.effective_until is null order by t.id desc limit 1`,[org,id])).rows[0]||null;
 const plans=(await db.query(`select p.id::text,p.name,p.currency from agency_plans p where p.organization_id=$1 and p.active
  and not exists(select 1 from agency_archived_records a where a.organization_id=p.organization_id and a.kind='plans' and a.record_id=p.id) order by p.name,p.id`,[org])).rows;
 const collaborators=(await db.query(`select c.id::text,c.full_name from agency_collaborators c where c.organization_id=$1 and c.active and ${'not exists(select 1 from agency_archived_records a where a.organization_id=c.organization_id and a.kind=\'collaborators\' and a.record_id=c.id)'} order by c.full_name,c.id`,[org])).rows;
 return {clientId:client.id,archived:client.archived,
  terms:terms&&projectMoney(terms,['recurringAmount','commissionValue']),plans,collaborators};
}
async function ensureCustomPlan(db,org) {
 const existing=(await db.query(`select id from agency_plans p where p.organization_id=$1 and p.name='Plan personalizado' and p.active
  and not exists(select 1 from agency_archived_records a where a.organization_id=p.organization_id and a.kind='plans' and a.record_id=p.id) order by p.id limit 1`,[org])).rows[0];
 if(existing)return existing.id;
 return (await db.query(`insert into agency_plans(organization_id,name,currency,items,notes) values($1,'Plan personalizado','PYG','[]','Plan personalizado con precio manual.') returning id`,[org])).rows[0].id;
}
async function validateTerms(db,org,input,current=null) {
 validateFields(input,termFields,'condiciones comerciales');
 if(termFields.filter(field=>!['cadence','intervalMonths','endsOn'].includes(field)).some(field=>!Object.hasOwn(input,field)))fail('Completá todas las condiciones comerciales');
 const planInput=String(input.planId||'');
 const planId=planInput===''?await ensureCustomPlan(db,org):id(planInput,'Plan');
 const recurringAmount=wholeAmount(input.recurringAmount,'El importe recurrente');
 // Las seis monedas del sistema: la tabla ya admite EUR/BRL/ARS/MXN.
 const currency=currencies.includes(input.currency)?input.currency:fail('Moneda inválida');
 const startsOn=requiredDate(input.startsOn,'Fecha de inicio');
 const endsOn=optionalDate(input.endsOn,'Fecha de fin');
 if(endsOn&&endsOn<startsOn)fail('La fecha de fin no puede ser anterior al inicio');
 const hasCadence=Object.hasOwn(input,'cadence')&&input.cadence!==undefined;
 const cadence=hasCadence?option(input.cadence,['monthly','interval','once']):(current?.cadence??'monthly');
 const hasInterval=Object.hasOwn(input,'intervalMonths')&&input.intervalMonths!==undefined;
 const rawInterval=cadence==='interval'?Number(hasInterval?input.intervalMonths:current?.interval_months??1):1;
 const intervalMonths=Number.isInteger(rawInterval)&&rawInterval>=1&&rawInterval<=24?rawInterval:fail('El intervalo debe ser entre 1 y 24 meses');
 if(typeof input.invoiceRequired!=='boolean')fail('invoiceRequired debe ser booleano');
 const commissionMode=['percentage','fixed','none'].includes(input.commissionMode)?input.commissionMode:fail('Modo de comisión inválido');
 let recipientId=null,commissionValue=null;
 if(commissionMode==='none'){
  if(input.commissionRecipientId!==null||input.commissionValue!==null)fail('Una comisión sin definir no admite destinatario ni importe');
 }else{
  recipientId=id(input.commissionRecipientId,'Colaborador');commissionValue=wholeAmount(input.commissionValue,'La comisión');
  if(commissionMode==='percentage'&&commissionValue>100)fail('La comisión porcentual no puede superar 100');
  const recipient=(await db.query(`select id from agency_collaborators c where c.organization_id=$1 and c.id=$2 and c.active
   and not exists(select 1 from agency_archived_records a where a.organization_id=c.organization_id and a.kind='collaborators' and a.record_id=c.id) for share`,[org,recipientId])).rows[0];
  if(!recipient)fail('El destinatario de comisión debe ser un colaborador activo de esta empresa');
 }
  const plan=(await db.query(`select id from agency_plans p where p.organization_id=$1 and p.id=$2 and p.active
   and not exists(select 1 from agency_archived_records a where a.organization_id=p.organization_id and a.kind='plans' and a.record_id=p.id) for share`,[org,planId])).rows[0];
  if(!plan)fail('Plan no disponible en esta empresa');
  return {planId,recipientId,recurringAmount,currency,startsOn,endsOn,cadence,intervalMonths,invoiceRequired:input.invoiceRequired,commissionMode,commissionValue};
}
async function plannedExpenses(db,org,month) {
 const records=(await db.query(`select id::text as id,cadence,effective_month::text as "effectiveMonth",category,amount::text as amount,currency,note,kind,
  created_by_user_id::text as "createdByUserId",created_at as "createdAt",updated_at as "updatedAt"
  from agency_planned_expenses where organization_id=$1 and (cadence='monthly' and effective_month=$2::date or cadence='recurring' and effective_month<=$2::date)
  order by currency,category,id`,[org,`${month}-01`])).rows;
 const totals=(await db.query(`select currency,coalesce(sum(amount),0)::text as amount from agency_planned_expenses
  where organization_id=$1 and (cadence='monthly' and effective_month=$2::date or cadence='recurring' and effective_month<=$2::date)
  group by currency order by currency`,[org,`${month}-01`])).rows;
 return {month,records:records.map(record=>projectMoney(record,['amount'])),totals:totals.map(total=>projectMoney(total,['amount']))};
}
async function validateExpense(input) {
 validateFields(input,expenseFields,'gasto planificado');
 if(expenseFields.filter(field=>field!=='kind').some(field=>!Object.hasOwn(input,field)))fail('Completá todos los campos del gasto planificado');
 const cadence=['monthly','recurring'].includes(input.cadence)?input.cadence:fail('Cadencia inválida');
 const effectiveMonth=monthDate(input.effectiveMonth,'Mes efectivo');
 if(typeof input.category!=='string'||input.category.trim().length<1||input.category.trim().length>120)fail('Categoría inválida');
 if(!currencies.includes(input.currency))fail('Moneda inválida');
 if(input.note!==null&&input.note!==undefined&&(typeof input.note!=='string'||input.note.length>1000))fail('Nota inválida');
 let kind=null;
 if(input.kind!==undefined&&input.kind!==null){
  if(!['fixed','variable'].includes(input.kind))fail('Tipo de gasto inválido');
  kind=input.kind;
 }
 return {cadence,effectiveMonth,category:input.category.trim(),amount:wholeAmount(input.amount,'El importe'),currency:input.currency,note:input.note?.trim()||null,kind};
}
const insertCommercialTerm=(connection,organization,clientId,value)=>connection.query(`insert into agency_client_commercial_terms(organization_id,client_id,plan_id,recurring_amount,currency,starts_on,ends_on,invoice_required,commission_recipient_id,commission_mode,commission_value,cadence,interval_months) values($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$12,$13)`,[organization,clientId,value.planId,value.recurringAmount,value.currency,value.startsOn,value.endsOn,value.invoiceRequired,value.recipientId,value.commissionMode,value.commissionValue,value.cadence,value.intervalMonths]);
export async function reports({req,res,url,db,session,body,send}) {
 const aggregate=url.pathname==='/api/agency/reports',match=url.pathname.match(/^\/api\/agency\/clients\/([1-9]\d*)\/reporting$/),termsMatch=url.pathname.match(/^\/api\/agency\/clients\/([1-9]\d*)\/commercial-terms$/),expenseMatch=url.pathname.match(/^\/api\/agency\/planned-expenses(?:\/([1-9]\d*))?$/);
 if(!aggregate&&!match&&!termsMatch&&!expenseMatch)return false;
 let c;
 try {
  const user=await session(req);
  await authorize(db,user,aggregate?'reports.view':expenseMatch?'expenses.manage':(match||termsMatch)&&req.method==='PATCH'?'commercial-terms.manage':'billing.view');
  if(aggregate){
   if(req.method!=='GET')fail('Método no permitido',405);
   send(res,200,await agencyReport(db,user.organization_id,{month:url.searchParams.get('month'),months:url.searchParams.get('months')}));return true;
  }
  if(expenseMatch){
   const month=forecastMonth(url.searchParams.get('month'));
   if(req.method==='GET'){send(res,200,await plannedExpenses(db,user.organization_id,month));return true;}
   if(req.method==='POST'&&!expenseMatch[1]){
    const value=await validateExpense(await body(req));c=await db.connect();await c.query('begin');await authorize(c,user,'expenses.manage');
    await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket?.remoteAddress||'']);
    const expense=(await c.query(`insert into agency_planned_expenses(organization_id,cadence,effective_month,category,amount,currency,note,kind,created_by_user_id)
     values($1,$2,$3::date,$4,$5,$6,$7,$8,$9) returning id::text as id,cadence,effective_month::text as "effectiveMonth",category,amount::text as amount,currency,note,kind`,[user.organization_id,value.cadence,value.effectiveMonth,value.category,value.amount,value.currency,value.note,value.kind,user.id])).rows[0];
    await c.query('commit');c.release();c=null;send(res,201,{expense:projectMoney(expense,['amount'])});return true;
   }
   if((req.method==='PATCH'||req.method==='DELETE')&&expenseMatch[1]){
    c=await db.connect();await c.query('begin');await authorize(c,user,'expenses.manage');
    await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket?.remoteAddress||'']);
    const existing=(await c.query('select id from agency_planned_expenses where organization_id=$1 and id=$2 for update',[user.organization_id,expenseMatch[1]])).rows[0];if(!existing)fail('Gasto planificado no encontrado',404);
    if(req.method==='DELETE'){await c.query('delete from agency_planned_expenses where organization_id=$1 and id=$2',[user.organization_id,expenseMatch[1]]);await c.query('commit');c.release();c=null;send(res,200,{deleted:true});return true;}
    const value=await validateExpense(await body(req));
    const expense=(await c.query(`update agency_planned_expenses set cadence=$3,effective_month=$4::date,category=$5,amount=$6,currency=$7,note=$8,kind=$9,updated_at=clock_timestamp()
     where organization_id=$1 and id=$2 returning id::text as id,cadence,effective_month::text as "effectiveMonth",category,amount::text as amount,currency,note,kind`,[user.organization_id,expenseMatch[1],value.cadence,value.effectiveMonth,value.category,value.amount,value.currency,value.note,value.kind])).rows[0];
    await c.query('commit');c.release();c=null;send(res,200,{expense:projectMoney(expense,['amount'])});return true;
   }
   fail('Método no permitido',405);
  }
  const id=(match||termsMatch)[1];if(BigInt(id)>9223372036854775807n)fail('Cliente no encontrado',404);
  if(termsMatch){
   if(req.method==='GET'){send(res,200,await commercialTerms(db,user.organization_id,id));return true;}
   if(req.method!=='PATCH')fail('Método no permitido',405);
   c=await db.connect();await c.query('begin');await authorize(c,user,'commercial-terms.manage');
   await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket?.remoteAddress||'']);
   const client=(await c.query(`select c.id from agency_clients c where c.organization_id=$1 and c.id=$2 and not exists(select 1 from agency_archived_records a where a.organization_id=c.organization_id and a.kind='clients' and a.record_id=c.id) for update`,[user.organization_id,id])).rows[0];
   if(!client)fail('Cliente no disponible',404);
   const open=(await c.query('select id,plan_name,monthly_price,effective_from,starts_on,version,cadence,interval_months from agency_client_commercial_terms where organization_id=$1 and client_id=$2 and effective_until is null for update',[user.organization_id,id])).rows[0];
   const value=await validateTerms(c,user.organization_id,await body(req),open);
   // The terms contract keeps one effective row per client. Rows written by the
   // commercial lifecycle carry the plan snapshot and belong to its append-only
   // history: an edit from the ficha closes the open term (version+1, the same
   // amendment rule) and appends the new one, so the cycle's optimistic version
   // keeps moving. Rows written by the terms contract itself have no snapshot and
   // are edited in place, the reconciliation the 20260915 migration documents.
   if(open&&(open.plan_name!==null||open.monthly_price!==null)){
    const priorStart=open.effective_from?dateString(open.effective_from).slice(0,10):open.starts_on?dateString(open.starts_on).slice(0,10):null;
    if(priorStart&&!(value.startsOn>priorStart))fail(`El término vigente pertenece al ciclo comercial: la enmienda debe empezar después del ${priorStart}`,409);
    const closedOn=new Date(`${value.startsOn}T12:00:00Z`);closedOn.setUTCDate(closedOn.getUTCDate()-1);
    const effectiveUntil=closedOn.toISOString().slice(0,10);
    const closed=(await c.query('update agency_client_commercial_terms set effective_until=$3::date,ends_on=$3::date,closed_at=now(),version=version+1,updated_at=clock_timestamp() where organization_id=$1 and client_id=$2 and id=$4 and effective_until is null and version=$5 returning id',[user.organization_id,id,effectiveUntil,open.id,open.version])).rows[0];
    if(!closed)fail('El término comercial cambió. Recargá antes de guardar.',409);
    await insertCommercialTerm(c,user.organization_id,id,value);
   }else if(open)await c.query(`update agency_client_commercial_terms set plan_id=$3,recurring_amount=$4,currency=$5,starts_on=$6::date,ends_on=$7::date,invoice_required=$8,commission_recipient_id=$9,commission_mode=$10,commission_value=$11,cadence=$12,interval_months=$13,updated_at=clock_timestamp() where organization_id=$1 and client_id=$2 and id=$14 and effective_until is null`,[user.organization_id,id,value.planId,value.recurringAmount,value.currency,value.startsOn,value.endsOn,value.invoiceRequired,value.recipientId,value.commissionMode,value.commissionValue,value.cadence,value.intervalMonths,open.id]);
    else await insertCommercialTerm(c,user.organization_id,id,value);
   const result=await commercialTerms(c,user.organization_id,id);await c.query('commit');c.release();c=null;send(res,200,result);return true;
  }
  if(req.method==='GET'){send(res,200,await metadata(db,user.organization_id,id));return true;}
  if(req.method!=='PATCH')fail('Método no permitido',405);
  const input=await body(req);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['expectedVersion','customerKind','servicePlanId','relationshipStartedOn'].includes(k)))fail('Campos de reporte inválidos');
  if(!['string','number'].includes(typeof input.expectedVersion)||! /^[1-9]\d{0,18}$/.test(String(input.expectedVersion??'')))fail('expectedVersion es obligatorio');
  if(Object.hasOwn(input,'customerKind')&&!kinds.includes(input.customerKind))fail('Tipo de cliente inválido');
  if(Object.hasOwn(input,'servicePlanId')&&input.servicePlanId!==null&&(!['string','number'].includes(typeof input.servicePlanId)||!/^[1-9]\d{0,18}$/.test(String(input.servicePlanId))||BigInt(input.servicePlanId)>9223372036854775807n))fail('Plan inválido');
  if(Object.hasOwn(input,'relationshipStartedOn')&&input.relationshipStartedOn!==null){
   const v=input.relationshipStartedOn;
   if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||v<'1900-01-01'||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)fail('Fecha de inicio inválida');
  }
  c=await db.connect();await c.query('begin');
  await authorize(c,user,'commercial-terms.manage');
  await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket?.remoteAddress||'']);
  const row=(await c.query('select *,relationship_started_on::text as relationship_started_on from agency_clients where organization_id=$1 and id=$2 for update',[user.organization_id,id])).rows[0];
  if(!row)fail('Cliente no encontrado',404);
  if(String(row.reporting_version)!==String(input.expectedVersion))fail('El cliente cambió. Actualizá los datos antes de guardar.',409);
  if((await c.query("select 1 from agency_archived_records where organization_id=$1 and kind='clients' and record_id=$2",[user.organization_id,id])).rows.length)fail('Restaurá el cliente antes de editarlo',409);
  if(input.servicePlanId!==undefined&&input.servicePlanId!==null&&String(input.servicePlanId)!==String(row.service_plan_id)){
   if(!(await c.query("select p.id from agency_plans p where p.organization_id=$1 and p.id=$2 and p.active and not exists(select 1 from agency_archived_records a where a.organization_id=p.organization_id and a.kind='plans' and a.record_id=p.id) for share",[user.organization_id,input.servicePlanId])).rows.length)fail('Plan no disponible en esta empresa');
  }
  if(input.relationshipStartedOn&&(await c.query("select $1::date>(clock_timestamp() at time zone 'America/Asuncion')::date future",[input.relationshipStartedOn])).rows[0].future)fail('La fecha de inicio no puede ser futura');
  await c.query('update agency_clients set customer_kind=$3,service_plan_id=$4,relationship_started_on=$5,updated_at=clock_timestamp() where organization_id=$1 and id=$2',[user.organization_id,id,input.customerKind??row.customer_kind,Object.hasOwn(input,'servicePlanId')?input.servicePlanId:row.service_plan_id,Object.hasOwn(input,'relationshipStartedOn')?input.relationshipStartedOn:row.relationship_started_on]);
  const result=await metadata(c,user.organization_id,id);await c.query('commit');send(res,200,result);
 }catch(error){
  if(c)await c.query('rollback');
  // A concurrent close holds the open term (the immutability guard and the open-row
  // unique index raise here too), so those conflicts answer 409 instead of 500.
  // 23505 (índice único), 40001/40P01 (serialización) son carreras: 409. Una
  // violación de check (23514) es dato inválido, no un cambio de términos.
  const conflict=['23505','40001','40P01'].includes(error.code);
  const invalidCheck=error.code==='23514';
  send(res,conflict?409:invalidCheck?400:error.status||500,{error:conflict?'Los términos comerciales cambiaron. Recargá antes de guardar.':error.status?error.message:'No se pudo completar el informe'});
 }
 finally{c?.release();}
 return true;
}
