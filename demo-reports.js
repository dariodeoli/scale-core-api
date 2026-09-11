// Internal fixture builder only. The caller must supply the transaction that
// created this private demo, after its clients/plans/current receipts are seeded.
// No provider calls, credential reads, real payments or aggregate report rows.
const version='DEMO-REPORTS-V1';
const note='Historia ilustrativa de una demo privada: fechas relativas y movimientos ficticios; no son documentos fiscales ni pagos reales.';
const completeNote=`${version}:complete · ${note}`;
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
const validId=value=>/^[1-9]\d{0,18}$/.test(String(value));

async function context(c,organizationId,userId){
 const organization=(await c.query(`select o.id,o.slug,o.demo_owner_user_id,o.active,
   o.created_at=transaction_timestamp() as newly_created,
   exists(select 1 from organization_members m where m.organization_id=o.id
    and m.user_id=$2 and m.active and m.removed_at is null) as member_active
  from organizations o where o.id=$1 for update`,[organizationId,userId])).rows[0];
 if(!organization||!organization.active||!organization.demo_owner_user_id||
  String(organization.demo_owner_user_id)!==String(userId)||!organization.member_active||
  !organization.slug.startsWith('demo-session-'))fail('Solo se permite generar historia en la nueva demo privada de este usuario',403);
 const done=(await c.query('select id from agency_invoices where organization_id=$1 and notes=$2 limit 1',[organizationId,completeNote])).rows[0];
 if(done)return null;
 if(!organization.newly_created)fail('La historia solo se genera durante el alta de una demo nueva');
 const opened=(await c.query(`select exists(select 1 from sessions where organization_id=$1)
   or exists(select 1 from agency_demo_sessions where organization_id=$1) as opened`,[organizationId])).rows[0];
 if(opened.opened)fail('No se modifican demos que ya fueron abiertas');
 const calendar=(await c.query(`select month_offset,
   to_char(date_trunc('month',current_date)+month_offset*interval '1 month','YYYY-MM') as month,
   (date_trunc('month',current_date)+month_offset*interval '1 month')::date::text as starts_on,
   (date_trunc('month',current_date)+month_offset*interval '1 month'+interval '9 days')::date::text as due_on,
   (date_trunc('month',current_date)+month_offset*interval '1 month'+interval '14 days')::date::text as paid_on
  from generate_series(-6,0) as months(month_offset) order by month_offset`)).rows;
 const clients=(await c.query(`select c.id,c.name,c.email,c.active,c.lifecycle_status,
   c.created_at=transaction_timestamp() as newly_created,
   i.id as invoice_id,i.currency,i.total::text,
   (select count(*)::int from agency_invoices n where n.organization_id=c.organization_id and n.client_id=c.id) as invoice_count,
   (select p.account_id from agency_payments p join bank_accounts a
      on a.id=p.account_id and a.organization_id=p.organization_id and a.currency=i.currency and a.active
    where p.organization_id=c.organization_id and p.invoice_id=i.id order by p.id limit 1) as receipt_account_id
  from agency_clients c left join agency_invoices i on i.client_id=c.id and i.organization_id=c.organization_id
   and i.issued_on>=date_trunc('month',current_date)::date and i.issued_on<=current_date
  where c.organization_id=$1 order by c.id`,[organizationId])).rows;
 if(clients.length!==20||clients.some(client=>!client.newly_created||!client.active||client.lifecycle_status!=='active'||
   !/^cliente\d+@demo\.example\.invalid$/.test(client.email)||client.invoice_count!==1||!client.invoice_id||
   !['PYG','USD'].includes(client.currency)||!/^\d+(\.\d{1,2})?$/.test(client.total)||Number(client.total)<=0)){
  fail('Se requieren los 20 clientes ficticios nuevos y sus facturas actuales, sin modificar');
 }
 const accounts=(await c.query('select id,currency from bank_accounts where organization_id=$1 and active order by id',[organizationId])).rows;
 for(const client of clients){
  client.accountId=client.receipt_account_id||accounts.find(account=>account.currency===client.currency)?.id;
  if(!client.accountId)fail('Falta una cuenta de la misma moneda para el historial de demo');
 }
 // Current: 20 clients. Closed months: 4,6,7,10,13,18 active clients.
 // Two one-month pauses end before the current month; current stats stay intact.
 const starts=[-6,-6,-6,-6,-5,-5,-4,-4,-3,-3,-2,-2,-2,-2,-1,-1,-1,-1,0,0];
 clients.forEach((client,index)=>{
  client.startOffset=starts[index];
  client.pauseOffset=index===0?-4:index===1?-2:null;
 });
 return{clients,calendar};
}

async function seedFinancialHistory(c,organizationId,userId,{clients,calendar}){
 let invoiceCount=0,paymentCount=0,markerInvoice;
 for(const month of calendar.filter(month=>month.month_offset<0)){
  for(const client of clients.filter(client=>client.startOffset<=month.month_offset&&client.pauseOffset!==month.month_offset)){
   const number=`${version}-${month.month}-${client.id}`;
   const invoice=(await c.query(`insert into agency_invoices
     (organization_id,client_id,number,total,currency,issued_on,due_on,notes,created_at)
    values($1,$2,$3,$4,$5,$6::date,$7::date,$8,$6::date::timestamp at time zone 'America/Asuncion') returning id`,
   [organizationId,client.id,number,client.total,client.currency,month.starts_on,month.due_on,note])).rows[0];
   await c.query(`insert into agency_payments
     (organization_id,invoice_id,account_id,amount,received_by_user_id,received_on,reference,request_key,created_at)
    values($1,$2,$3,$4,$5,$6::date,$7,$8,$6::date::timestamp at time zone 'America/Asuncion')`,
   [organizationId,invoice.id,client.accountId,client.total,userId,month.paid_on,note,number]);
   // Account balances and invoice payment state are maintained exclusively by
   // the existing receipt triggers. Current receipts are never touched.
   markerInvoice??=invoice.id;invoiceCount++;paymentCount++;
  }
 }
 if(invoiceCount>60||invoiceCount!==58)fail('El historial excede el límite previsto de la demo');
 return{invoiceCount,paymentCount,markerInvoice};
}

async function seedClientHistory(c,organizationId,{clients,calendar}){
 const plans=(await c.query(`select id,name,currency from agency_plans p where organization_id=$1 and active
  and not exists(select 1 from agency_archived_records a where a.organization_id=p.organization_id and a.kind='plans' and a.record_id=p.id)
  order by id`,[organizationId])).rows;
 const names=['Inicio','Crecimiento','Integral','Internacional'];
 if(plans.length!==4||names.some(name=>plans.filter(plan=>plan.name===name).length!==1))fail('Se requieren los cuatro planes originales de la demo');
 const byName=new Map(plans.map(plan=>[plan.name,plan]));
 let eventCount=0;
 for(const [index,client] of clients.entries()){
  const plan=byName.get(client.currency==='USD'?'Internacional':Number(client.total)<=4000000?'Inicio':Number(client.total)<=5000000?'Crecimiento':'Integral');
  if(plan.currency!==client.currency)fail('El plan y la factura de demo deben usar la misma moneda');
  const kind=[2,6,9].includes(index)?'professional':index===12?'other':index===19?'individual':'company';
  const start=calendar.find(month=>month.month_offset===client.startOffset).starts_on;
  // The catalog is a template, not the agreed monthly price. In particular the
  // existing 4m/7m invoices stay unchanged; every historic invoice copies the
  // client's current agreed amount rather than silently repricing the fixture.
  await c.query(`update agency_clients set customer_kind=$3,service_plan_id=$4,relationship_started_on=$5::date,
    created_at=$5::date::timestamp at time zone 'America/Asuncion',
    notes=concat_ws(E'\n',notes,$6::text),updated_at=clock_timestamp()
   where organization_id=$1 and id=$2`,[organizationId,client.id,kind,plan.id,start,
   `${note} Plan de referencia: ${plan.name}; importe mensual acordado ${client.currency} ${client.total}, conservado de su factura actual.`]);
  const snapshots=[{offset:client.startOffset,event:'created',status:'active'}];
  if(client.pauseOffset!==null)snapshots.push({offset:client.pauseOffset,event:'changed',status:'paused'},{offset:client.pauseOffset+1,event:'changed',status:'active'});
  for(const snapshot of snapshots){
   const at=calendar.find(month=>month.month_offset===snapshot.offset).starts_on;
   await c.query(`insert into agency_client_reporting_events
     (organization_id,client_id,event_at,event_kind,active,lifecycle_status,archived,customer_kind,
      service_plan_id,service_plan_name,relationship_started_on)
    values($1,$2,$3::date::timestamp at time zone 'America/Asuncion',$4,true,$5,false,$6,$7,$8,$9::date)`,
   [organizationId,client.id,at,snapshot.event,snapshot.status,kind,plan.id,plan.name,start]);
   eventCount++;
  }
 }
 // Actual INSERT/UPDATE snapshots remain append-only. In the current month the
 // latest automatic UPDATE snapshot matches the current active client exactly.
 await c.query(`update agency_reporting_coverage set history_since=$2::date::timestamp at time zone 'America/Asuncion'
  where organization_id=$1`,[organizationId,calendar[0].starts_on]);
 return eventCount;
}

export async function seedDemoReports(c,{organizationId,userId}){
 if(!validId(organizationId)||!validId(userId))fail('Identificadores de demo inválidos',400);
 // SAVEPOINT deliberately requires a caller-owned transaction. It also prevents
 // partial fixture writes if the caller catches a failure instead of aborting.
 await c.query('savepoint demo_reports_v1');
 try{
  const data=await context(c,organizationId,userId);
  if(!data){await c.query('release savepoint demo_reports_v1');return{seeded:false};}
  const eventCount=await seedClientHistory(c,organizationId,data);
  const financial=await seedFinancialHistory(c,organizationId,userId,data);
  // A completion marker on our own invoice avoids adding synthetic telemetry.
  await c.query('update agency_invoices set notes=$3 where organization_id=$1 and id=$2',[organizationId,financial.markerInvoice,completeNote]);
  await c.query('release savepoint demo_reports_v1');
  return{seeded:true,invoiceCount:financial.invoiceCount,paymentCount:financial.paymentCount,eventCount};
 }catch(error){
  await c.query('rollback to savepoint demo_reports_v1');
  await c.query('release savepoint demo_reports_v1');
  throw error;
 }
}
