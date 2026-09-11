const timezone='America/Asuncion';
const reportRoles=['owner','admin','finance'];
const editRoles=['owner','admin','management','sales'];
const metadataRoles=[...editRoles,'finance'];
const kinds=['unknown','company','professional','individual','other'];
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const dateString=value=>value instanceof Date?value.toISOString().slice(0,10):value;
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
  months:rows.map(r=>({month:r.month.slice(0,7),isPartial:r.partial,clients:r.clients,financial:r.financial}))};
}

async function authorize(db,user,roles) {
 if(!user)fail('No autenticado',401);
 if(!roles.includes(user.role))fail('Tu rol no permite esta operación',403);
 const member=(await db.query('select m.role from organization_members m join organizations o on o.id=m.organization_id where m.user_id=$1 and m.organization_id=$2 and m.active and m.removed_at is null and o.active',[user.id,user.organization_id])).rows[0];
 if(!member||!roles.includes(member.role))fail('Sin acceso a esta empresa',403);
}
async function metadata(db,org,id) {
 const row=(await db.query(`select c.id::text,c.customer_kind,c.service_plan_id::text,c.relationship_started_on::text,c.reporting_version::text,c.updated_at,
  exists(select 1 from agency_archived_records a where a.organization_id=c.organization_id and a.kind='clients' and a.record_id=c.id) archived
  from agency_clients c where c.organization_id=$1 and c.id=$2`,[org,id])).rows[0];
 if(!row)fail('Cliente no encontrado',404);
 const plans=(await db.query("select p.id::text,p.name from agency_plans p where p.organization_id=$1 and p.active and not exists(select 1 from agency_archived_records a where a.organization_id=p.organization_id and a.kind='plans' and a.record_id=p.id) order by p.name,p.id",[org])).rows;
 return {reporting:{clientId:row.id,customerKind:row.customer_kind,servicePlanId:row.service_plan_id,relationshipStartedOn:dateString(row.relationship_started_on),version:row.reporting_version,updatedAt:new Date(row.updated_at).toISOString(),archived:row.archived},plans};
}
export async function reports({req,res,url,db,session,body,send}) {
 const aggregate=url.pathname==='/api/agency/reports',match=url.pathname.match(/^\/api\/agency\/clients\/([1-9]\d*)\/reporting$/);
 if(!aggregate&&!match)return false;
 let c;
 try {
  const user=await session(req);
  await authorize(db,user,aggregate?reportRoles:req.method==='PATCH'?editRoles:metadataRoles);
  if(aggregate){
   if(req.method!=='GET')fail('Método no permitido',405);
   send(res,200,await agencyReport(db,user.organization_id,{month:url.searchParams.get('month'),months:url.searchParams.get('months')}));return true;
  }
  const id=match[1];if(BigInt(id)>9223372036854775807n)fail('Cliente no encontrado',404);
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
  await authorize(c,user,editRoles);
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
 }catch(error){if(c)await c.query('rollback');send(res,error.status||500,{error:error.status?error.message:'No se pudo completar el informe'});}
 finally{c?.release();}
 return true;
}
