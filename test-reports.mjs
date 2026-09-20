import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {reports,agencyReport,reportingPeriod} from './reports.js';
import {CAPABILITIES} from './permissions.js';
// Mismo criterio que la matriz de capacidades, sin depender de un export muerto.
const capabilityDefault=(capability,role)=>Boolean(CAPABILITIES.find(entry=>entry.id===capability)?.roles.includes(role));
import {recordLifecycle} from './record-lifecycle.js';
import {suite} from './agency-suite.js';

const pg=new PGlite();
await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
const migrationFiles=['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql','20260910_productivity.sql','20260910_client_links.sql','20260910_client_lifecycle.sql','20260910_currencies.sql','20260910_company_currency.sql','20260914_client_commercial_lifecycle.sql','20260914_salary_forecast.sql','20260914_client_terms_and_planned_expenses.sql','20260915_optional_commission_terms.sql','20260915_billing_cadence_and_coupons.sql','20260915_client_terms_end_date.sql','20260915_planned_expense_kind.sql','20260920_currency_widening.sql'];
for(const name of migrationFiles)await pg.exec(await fs.readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8'));
const query=(sql,args=[])=>pg.query(sql,args),db={query,connect:async()=>({query,release(){}})};
const one=async(sql,args)=>(await query(sql,args)).rows[0];
const org=(await one("select id from organizations where slug='scale'")).id;
const legacy=(await one("insert into agency_clients(organization_id,name,created_at) values($1,'Existing client','2020-01-01') returning id",[org])).id;
const migration=await fs.readFile(new URL('./migrations/20260911_agency_reports.sql',import.meta.url),'utf8');
await pg.exec(migration);
const observed=await one('select * from agency_client_reporting_events where client_id=$1',[legacy]);
assert.equal(observed.event_kind,'observed');assert.equal(observed.relationship_started_on,null);assert.equal(observed.customer_kind,'unknown');
await pg.exec(migration);assert.equal((await one('select count(*)::int n from agency_client_reporting_events where client_id=$1',[legacy])).n,1);
let n=0;const fixed=new Date('2024-04-15T15:00:00Z');
const uid=(await one("insert into users(email,password_hash) values('reports@example.invalid','unused') returning id")).id;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,uid]);
let user={id:uid,organization_id:org,role:'owner'};
async function call(path,method='GET',input={},as=user,handler=reports){
 let result;assert.equal(await handler({req:{method,socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://fixture.invalid'+path),db,session:async()=>as,body:async()=>input,send:(_,status,data)=>{result={status,...data};}}),true);n++;return result;
}
const fresh=(await one("insert into organizations(slug,name) values('reports-fresh','Fresh') returning id")).id;
assert((await one('select history_since from agency_reporting_coverage where organization_id=$1',[fresh])).history_since);
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[fresh,uid]);
const client=(await one("insert into agency_clients(organization_id,name) values($1,'Current') returning *",[fresh]));
const today=(await one("select (now() at time zone 'America/Asuncion')::date::text as local_day")).local_day;
assert.equal(client.relationship_started_on.toISOString().slice(0,10),today);
assert.equal((await one('select event_kind from agency_client_reporting_events where client_id=$1',[client.id])).event_kind,'created');
assert.equal((await agencyReport(db,org,{month:'2020-01',months:1})).months[0].clients.active,null);
const current=await agencyReport(db,org,{months:2});assert.equal(current.months[1].isPartial,true);assert.equal(current.months[1].clients.active,1);assert.equal(current.months[1].clients.added,null);assert.equal(current.months[1].clients.tenureKnown,0);assert.equal(current.months[1].clients.averageTenureDays,null);
assert.equal(reportingPeriod(null,1,new Date('2026-10-01T02:59:59Z')).month,'2026-09');
assert.equal(reportingPeriod(null,1,new Date('2026-10-01T03:00:00Z')).month,'2026-10');
for(const month of ['2024-00','2024-13','2024-2','2024-02-01','1899-12','9999-01',''])assert.throws(()=>reportingPeriod(month,1,fixed));
for(const months of [0,25,-1,1.5,'01','1e1','12x',''])assert.throws(()=>reportingPeriod('2024-01',months,fixed));
assert.equal(reportingPeriod('2024-02',24,fixed).months,24);
assert.equal((await call('/api/agency/reports','GET',{},null)).status,401);
// Informes stays gated by the reports.view capability: owner, admin, finance and
// sales today. The expectation is derived from the matrix so the suite cannot
// drift again when the capability changes.
assert.deepEqual(['owner','admin','finance','sales'].every(role=>capabilityDefault('reports.view',role)),true,'reports.view keeps its documented roles');
for(const role of ['management','sales','production','editor','viewer'])assert.equal((await call('/api/agency/reports','GET',{}, {...user,role})).status,capabilityDefault('reports.view',role)?200:403,`reports.view decides the Informes session role ${role}`);
for(const role of ['owner','admin','finance']){
 await query('update organization_members set role=$3 where organization_id=$1 and user_id=$2',[org,uid,role]);
 assert.equal((await call('/api/agency/reports?month=2024-02&months=1','GET',{}, {...user,role})).status,200);
}
await query("update organization_members set role='viewer' where organization_id=$1 and user_id=$2",[org,uid]);
assert.equal((await call('/api/agency/reports')).status,403,'forged session role must not elevate viewer');
await query("update organization_members set role='owner',active=false where organization_id=$1 and user_id=$2",[org,uid]);
assert.equal((await call('/api/agency/reports')).status,403);
await query("update organization_members set active=true where organization_id=$1 and user_id=$2",[org,uid]);
assert.equal((await call('/api/agency/reports','POST')).status,405);
assert.equal((await call('/api/agency/reports?month=9999-01')).status,400);
assert.equal((await call('/api/agency/reports?months=25')).status,400);
assert.equal(await reports({url:new URL('https://fixture.invalid/api/agency/clients')}),false);

// Metadata uses the real handler and actual tenant membership, including optimistic edits.
const p1=(await one("insert into agency_plans(organization_id,name) values($1,'Gold') returning id",[org])).id;
const p2=(await one("insert into agency_plans(organization_id,name) values($1,'Other org') returning id",[fresh])).id;
const inactive=(await one("insert into agency_plans(organization_id,name,active) values($1,'Inactive',false) returning id",[org])).id;
const path=`/api/agency/clients/${legacy}/reporting`;
let meta=await call(path);assert.deepEqual(meta.plans.map(p=>p.id),[String(p1)]);assert.equal(meta.reporting.version,'1');
assert.equal((await call(path,'PATCH',{customerKind:'company'})).status,400);
assert.equal((await call(path,'PATCH',{expectedVersion:'1',servicePlanId:p2})).status,400);
assert.equal((await call(path,'PATCH',{expectedVersion:'1',servicePlanId:inactive})).status,400);
for(const input of [{customerKind:'business'},{relationshipStartedOn:'2023-02-29'},{relationshipStartedOn:'2999-01-01'},{status:'active'},{organization_id:fresh},{servicePlanId:'9223372036854775808'}])assert.equal((await call(path,'PATCH',{expectedVersion:'1',...input})).status,400);
meta=await call(path,'PATCH',{expectedVersion:'1',customerKind:'company',servicePlanId:String(p1),relationshipStartedOn:'2024-02-29'});assert.equal(meta.status,200);assert.equal(meta.reporting.version,'2');assert.equal(meta.reporting.relationshipStartedOn,'2024-02-29');
assert.equal((await call(path,'PATCH',{expectedVersion:'1',customerKind:'individual'})).status,409);
assert.equal((await call(`/api/agency/clients/${client.id}/reporting`)).status,404);
assert.equal((await call(`/api/agency/clients/${client.id}/reporting`,'PATCH',{expectedVersion:'1',customerKind:'company'})).status,404);
await assert.rejects(query('update agency_clients set service_plan_id=$2 where id=$1',[legacy,p2]),/foreign key/i);
for(const role of ['owner','admin','management','sales','finance','production','editor','viewer']){
 await query('update organization_members set role=$3 where organization_id=$1 and user_id=$2',[org,uid,role]);
 const actor={...user,role},read=await call(path,'GET',{},actor);
 assert.equal(read.status,['owner','admin','management','sales','finance'].includes(role)?200:403);
 const write=await call(path,'PATCH',{expectedVersion:read.reporting?.version||'2',customerKind:'professional'},actor);
 assert.equal(write.status,['owner','admin','management','sales'].includes(role)?200:403);
}
await query("update organization_members set role='owner' where organization_id=$1 and user_id=$2",[org,uid]);
await call(`/api/agency/clients/${legacy}`,'DELETE',{},user,recordLifecycle);
assert.equal((await call(path)).reporting.archived,true);
meta=await call(path);assert.equal((await call(path,'PATCH',{expectedVersion:meta.reporting.version,customerKind:'other'})).status,409);
await call(`/api/agency/clients/${legacy}/restore`,'POST',{},user,recordLifecycle);
assert.equal((await call(path)).reporting.archived,false);
assert.deepEqual((await query("select event_kind from agency_client_reporting_events where client_id=$1 and event_kind in ('archived','restored') order by id",[legacy])).rows.map(r=>r.event_kind),['archived','restored']);
await assert.rejects(query('update agency_client_reporting_events set active=false where id=$1',[observed.id]),/append-only/);
await assert.rejects(query('delete from agency_client_reporting_events where id=$1',[observed.id]),/append-only/);

// Synthetic fixture inserts only, as in NEW demo seeding; no rewriting existing events.
await query("update agency_reporting_coverage set history_since='2024-01-01T03:00:00Z' where organization_id=$1",[fresh]);
const c2=(await one("insert into agency_clients(organization_id,name) values($1,'Second') returning id",[fresh])).id;
const c3=(await one("insert into agency_clients(organization_id,name) values($1,'Leap') returning id",[fresh])).id;
async function event(id,at,{kind='changed',active=true,archived=false,type='company',plan=p2,start='2024-01-01',status=active?'active':'paused',name='Original plan'}={}){
 await query('insert into agency_client_reporting_events(organization_id,client_id,event_at,event_kind,active,lifecycle_status,archived,customer_kind,service_plan_id,service_plan_name,relationship_started_on) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[fresh,id,at,kind,active,status,archived,type,plan,plan===null?null:name,start]);
}
await event(client.id,'2024-01-10T03:00:00Z',{kind:'created'});
await event(c2,'2024-01-31T23:00:00Z',{kind:'created',type:'professional',start:null,plan:null});
await event(client.id,'2024-02-15T12:00:00Z',{kind:'archived',archived:true});
await event(c3,'2024-03-01T02:59:59.999Z',{kind:'created',start:'2024-02-29'});
await event(c2,'2024-03-01T03:00:00Z',{active:false,type:'professional',start:null,plan:null});
await event(client.id,'2024-03-10T12:00:00Z',{kind:'restored'});
await event(c3,'2024-03-20T12:00:00Z',{type:'individual',start:'2024-02-29',name:'Renamed plan'});
// Equal timestamps: highest id wins, including lifecycle's two UPDATEs.
// April 2024 used UTC-4 in Asunción (historical DST), not today's UTC-3.
await event(c3,'2024-04-01T04:00:00Z',{active:false});
await event(c3,'2024-04-01T04:00:00Z',{active:true,type:'other'});
// A future current-month event must not appear yet.
await event(client.id,'2024-04-20T03:00:00Z',{archived:true,kind:'archived'});
const historical=await agencyReport(db,fresh,{month:'2024-04',months:5},fixed);
const [dec,jan,feb,mar,apr]=historical.months;
assert.equal(dec.clients.active,null);assert.equal(dec.isPartial,true);assert.equal(jan.isPartial,false);
assert.equal(jan.clients.active,2);assert.equal(jan.clients.added,2);assert.equal(jan.clients.lost,0);assert.equal(jan.clients.retentionPercent,null);assert.equal(jan.clients.tenureKnown,1);assert.equal(jan.clients.averageTenureDays,30);
assert.equal(feb.clients.active,2);assert.equal(feb.clients.added,1);assert.equal(feb.clients.lost,1);assert.equal(feb.clients.retentionPercent,50);assert.equal(feb.clients.averageTenureDays,0);
assert.equal(mar.clients.active,2);assert.equal(mar.clients.lost,1);assert.equal(mar.clients.retentionPercent,50);assert.equal(mar.clients.added,0);assert.equal(mar.isPartial,false);
assert.equal(apr.isPartial,true);assert.equal(apr.clients.active,2);assert(apr.clients.types.some(t=>t.kind==='other'));assert.equal(mar.clients.plans[0].name,'Renamed plan');assert.equal(feb.clients.plans[0].name,'Original plan');
// Duplicate synthetic creation must not appear as another acquisition in a later month.
await event(c2,'2024-04-02T04:00:00Z',{kind:'created',active:false,type:'professional',start:null,plan:null});
assert.equal((await agencyReport(db,fresh,{month:'2024-04',months:1},fixed)).months[0].clients.added,0);
await query("update agency_reporting_coverage set history_since='2024-01-15T03:00:00Z' where organization_id=$1",[fresh]);
const firstPartial=(await agencyReport(db,fresh,{month:'2024-02',months:2},fixed)).months;
assert.equal(firstPartial[0].isPartial,true);assert.equal(firstPartial[0].clients.active,2);assert.equal(firstPartial[0].clients.added,null);assert.equal(firstPartial[0].clients.lost,null);assert.equal(firstPartial[0].clients.retentionPercent,null);assert.equal(firstPartial[1].isPartial,false);
await query("update agency_reporting_coverage set history_since='2024-01-01T03:00:00Z' where organization_id=$1",[fresh]);
const atMonthBoundary=(await agencyReport(db,fresh,{month:'2024-03',months:1},new Date('2024-04-01T04:00:00Z'))).months[0];
assert.equal(atMonthBoundary.isPartial,false);assert.equal(atMonthBoundary.clients.lost,1,'events exactly at next local month are excluded');
await query("update agency_plans set name='Changed NOW' where id=$1",[p2]);
await query("update agency_clients set customer_kind='individual',relationship_started_on='2020-01-01' where id=$1",[client.id]);
assert.deepEqual((await agencyReport(db,fresh,{month:'2024-04',months:5},fixed)).months,historical.months,'present edits cannot rewrite past client snapshots');

// Numeric money never passes through JS float arithmetic. Archived clients keep invoices.
let seq=0;
async function invoice(customer,{date='2024-02-29',total='100.10',currency='USD',status='issued'}={}){
 return (await one('insert into agency_invoices(organization_id,client_id,number,issued_on,total,currency,status) values($1,$2,$3,$4,$5,$6,$7) returning id',[fresh,customer,`REPORT-${++seq}`,date,total,currency,status])).id;
}
const i1=await invoice(client.id);await invoice(client.id,{total:'200.20'});await invoice(c2,{total:'0.00'});
await invoice(c2,{currency:'PYG',total:'50000.00'});
for(const status of ['draft','cancelled'])await invoice(c2,{total:'999999.99',status});
await invoice(c2,{date:'2024-03-01',total:'50.50'});await invoice(c2,{date:'2024-04-20',total:'9999.00'});
await invoice(c2,{date:'2024-04-15',total:'0.00'});
const account=(await one("insert into bank_accounts(organization_id,name,account_type,currency,balance) values($1,'Reporting account','bank','USD',0) returning id",[fresh])).id;
const payment=(await one("insert into agency_payments(organization_id,invoice_id,account_id,amount,received_on) values($1,$2,$3,'30.10','2024-02-29') returning id",[fresh,i1,account])).id;
await query("insert into agency_payment_reversals(organization_id,payment_id,reason,reversed_on,created_by_user_id) values($1,$2,'Fixture','2024-03-01',$3)",[fresh,payment,uid]);
let financial=await agencyReport(db,fresh,{month:'2024-04',months:3},fixed);
const usd=financial.months[0].financial.find(f=>f.currency==='USD');
assert.equal(usd.invoiced,300);assert.equal(usd.collected,30);assert.equal(usd.invoiceCount,3);assert.equal(usd.billedClients,2);assert.equal(usd.averageTicket,100);assert.equal(usd.averageRevenuePerClient,150);
assert.equal(financial.months[0].financial.find(f=>f.currency==='PYG').invoiced,50000);
assert.equal(financial.months[1].financial[0].collected,-30);assert.equal(financial.months[2].financial[0].invoiced,0);assert.equal(financial.months[2].financial[0].averageTicket,0);
await call(`/api/agency/clients/${client.id}`,'DELETE',{}, {...user,organization_id:fresh},recordLifecycle);
assert.deepEqual((await agencyReport(db,fresh,{month:'2024-04',months:3},fixed)).months.map(m=>m.financial),financial.months.map(m=>m.financial));
assert.deepEqual((await agencyReport(db,org,{month:'2024-02',months:1},fixed)).months[0].financial,[],'no tenant financial leakage');
const receiptOnly=await invoice(c2,{date:'2024-01-01',total:'10.00'});
await query("insert into agency_payments(organization_id,invoice_id,account_id,amount,received_on) values($1,$2,$3,'10.00','2024-05-01')",[fresh,receiptOnly,account]);
const zero=(await agencyReport(db,fresh,{month:'2024-05',months:1},new Date('2024-06-01T04:00:00Z'))).months[0].financial[0];
assert.equal(zero.invoiceCount,0);assert.equal(zero.billedClients,0);assert.equal(zero.averageTicket,null);assert.equal(zero.averageRevenuePerClient,null);assert.equal(zero.collected,10);
// Existing lifecycle PATCH must still run both updates and produce a final truthful state.
const patched=await call(`/api/agency/clients/${legacy}`,'PATCH',{name:'Existing client',lifecycle_status:'paused'},user,suite);
assert.equal(patched.status,200);
const last=await one('select * from agency_client_reporting_events where client_id=$1 order by event_at desc,id desc limit 1',[legacy]);assert.equal(last.lifecycle_status,'paused');assert.equal(last.active,false);
// --- Términos comerciales y ciclo comercial -------------------------------------
const termsPlan=await one("insert into agency_plans(organization_id,name,currency,items) values($1,'Plan ficha','PYG','[]'::jsonb) returning id",[org]);
const termsClient=await one("insert into agency_clients(organization_id,name) values($1,'Términos') returning id",[org]);
const termsPath=`/api/agency/clients/${termsClient.id}/commercial-terms`;
// Una fila del ciclo comercial (plan_id null, snapshot del plan) se sirve con el
// contrato de la ficha: nombre del plan del snapshot y monto neto de descuentos.
await query("insert into agency_client_commercial_terms(organization_id,client_id,activation_date,effective_from,plan_name,plan_version,monthly_price,currency,discount_type,discount_value,starts_on) values($1,$2,'2026-01-01','2026-01-01','Plan ciclo','v3',100000,'PYG','percent',10,'2026-01-01')",[org,termsClient.id]);
const cycleRead=await call(termsPath,'GET',{},user);
assert.equal(cycleRead.status,200);
assert.equal(cycleRead.terms?.planName,'Plan ciclo','the lifecycle snapshot row is served instead of null');
assert.deepEqual({planId:cycleRead.terms.planId,planName:cycleRead.terms.planName,recurringAmount:cycleRead.terms.recurringAmount,commissionMode:cycleRead.terms.commissionMode,startsOn:cycleRead.terms.startsOn,cadence:cycleRead.terms.cadence},{planId:'',planName:'Plan ciclo',recurringAmount:90000,commissionMode:'none',startsOn:'2026-01-01',cadence:'monthly'},'the lifecycle snapshot row is served with its plan snapshot and net recurring amount');
// El mismo período no se reescribe: la enmienda necesita una fecha posterior.
const cycleRefused=await call(termsPath,'PATCH',{planId:String(termsPlan.id),recurringAmount:'130000',currency:'PYG',startsOn:'2026-01-01',endsOn:null,invoiceRequired:true,commissionRecipientId:null,commissionMode:'none',commissionValue:null},user);
assert.equal(cycleRefused.status,409,'a same-day edit of a cycle term is refused, never rewritten');
assert.match(cycleRefused.error,/ciclo comercial/,'the refusal explains where the term comes from');
const untouched=(await query('select plan_id,recurring_amount,monthly_price::text as monthly_price,plan_name,version from agency_client_commercial_terms where organization_id=$1 and client_id=$2',[org,termsClient.id])).rows;
assert.deepEqual(untouched,[{plan_id:null,recurring_amount:null,monthly_price:'100000.00',plan_name:'Plan ciclo',version:1}],'the refused edit never touched the cycle row');
// Con una fecha posterior, la ficha cierra el término del ciclo (version+1) y anexa el nuevo.
const cycleEdit=await call(termsPath,'PATCH',{planId:String(termsPlan.id),recurringAmount:'120000',currency:'PYG',startsOn:'2026-07-01',endsOn:null,invoiceRequired:true,commissionRecipientId:null,commissionMode:'none',commissionValue:null},user);
assert.equal(cycleEdit.status,200);assert.equal(cycleEdit.terms.recurringAmount,120000);assert.equal(cycleEdit.terms.planName,'Plan ficha');
const cycleRows=(await query('select id,effective_until::text as effective_until,ends_on::text as ends_on,version,plan_name,monthly_price::text as monthly_price from agency_client_commercial_terms where organization_id=$1 and client_id=$2 order by id',[org,termsClient.id])).rows;
assert.equal(cycleRows.length,2,'a ficha edit of a cycle term appends instead of rewriting it');
assert.deepEqual({until:cycleRows[0].effective_until,ends:cycleRows[0].ends_on,version:cycleRows[0].version,plan:cycleRows[0].plan_name,price:cycleRows[0].monthly_price},{until:'2026-06-30',ends:'2026-06-30',version:2,plan:'Plan ciclo',price:'100000.00'},'the closed cycle row keeps its snapshot and bumps its version');
assert.equal(cycleRows[1].effective_until,null,'the appended term stays open');
// La cadencia y el intervalo se conservan cuando el cuerpo no los manda.
const cadenceClient=await one("insert into agency_clients(organization_id,name) values($1,'Cadencia') returning id",[org]);
const cadencePath=`/api/agency/clients/${cadenceClient.id}/commercial-terms`;
const cadenceBody={planId:String(termsPlan.id),recurringAmount:'500000',currency:'PYG',startsOn:'2026-02-01',endsOn:null,invoiceRequired:false,commissionRecipientId:null,commissionMode:'none',commissionValue:null};
const cadenceFirst=await call(cadencePath,'PATCH',{...cadenceBody,cadence:'interval',intervalMonths:6},user);
assert.deepEqual({cadence:cadenceFirst.terms.cadence,interval:cadenceFirst.terms.intervalMonths},{cadence:'interval',interval:6},'an interval cadence is stored');
const cadenceSecond=await call(cadencePath,'PATCH',{...cadenceBody,recurringAmount:'600000'},user);
assert.deepEqual({cadence:cadenceSecond.terms.cadence,interval:cadenceSecond.terms.intervalMonths},{cadence:'interval',interval:6},'an absent cadence keeps the stored billing rhythm');
assert.equal((await query('select cadence,interval_months from agency_client_commercial_terms where organization_id=$1 and client_id=$2 and effective_until is null',[org,cadenceClient.id])).rows[0].interval_months,6,'the stored interval survives a second edit');
assert.equal((await call(cadencePath,'PATCH',{...cadenceBody,cadence:'weekly'},user)).status,400,'unknown cadences are rejected');
assert.equal((await call(cadencePath,'PATCH',{...cadenceBody,cadence:'interval',intervalMonths:25},user)).status,400,'intervals outside 1..24 are rejected');
const cadenceExplicit=await call(cadencePath,'PATCH',{...cadenceBody,cadence:'monthly'},user);
assert.deepEqual({cadence:cadenceExplicit.terms.cadence,interval:cadenceExplicit.terms.intervalMonths},{cadence:'monthly',interval:1},'an explicit cadence still changes and normalizes the interval');
// Cierre de las seis monedas: términos comerciales y gastos planificados aceptan
// EUR/BRL/ARS/MXN (la base y el validador estaban en PYG|USD) y rechazan el resto.
const sixCurrencies=['EUR','BRL','ARS','MXN'];
const euroClient=await one("insert into agency_clients(organization_id,name) values($1,'Monedas') returning id",[org]);
const euroPath=`/api/agency/clients/${euroClient.id}/commercial-terms`;
for(const currency of sixCurrencies){
 const saved=await call(euroPath,'PATCH',{...cadenceBody,currency},user);
 assert.equal(saved.status,200,`commercial terms accept ${currency}`);
 assert.equal(saved.terms.currency,currency,`commercial terms store ${currency}`);
 assert.equal((await query('select currency from agency_client_commercial_terms where organization_id=$1 and client_id=$2 and effective_until is null',[org,euroClient.id])).rows[0].currency,currency,`the ${currency} term is persisted`);
}
assert.equal((await call(euroPath,'PATCH',{...cadenceBody,currency:'GBP'},user)).status,400,'a seventh currency is rejected on commercial terms');
assert.equal((await call(euroPath,'PATCH',{...cadenceBody,currency:'eur'},user)).status,400,'currencies are uppercase codes');
const expenseMonth='2026-09';
for(const currency of sixCurrencies){
 const created=await call('/api/agency/planned-expenses','POST',{cadence:'monthly',effectiveMonth:expenseMonth,category:`Gasto ${currency}`,amount:'1500',currency,note:null,kind:'variable'},user);
 assert.equal(created.status,201,`planned expenses accept ${currency}`);
 assert.equal(created.expense.currency,currency,`planned expenses store ${currency}`);
}
assert.equal((await call('/api/agency/planned-expenses','POST',{cadence:'monthly',effectiveMonth:expenseMonth,category:'Gasto GBP',amount:'1500',currency:'GBP',note:null,kind:'variable'},user)).status,400,'a seventh currency is rejected on planned expenses');
const expenseList=await call(`/api/agency/planned-expenses?month=${expenseMonth}`, 'GET', {}, user);
for(const currency of sixCurrencies)assert.ok(expenseList.records.some(row=>row.currency===currency),`the ${currency} expense is listed`);
assert.ok(expenseList.totals.every(total=>sixCurrencies.concat(['PYG','USD']).includes(total.currency)),'totals stay inside the six currencies');
await query('delete from agency_planned_expenses where organization_id=$1 and category like $2',[org,'Gasto %']);
console.log(`PASS reports: ${n} real handler calls; migration repeatability, observation coverage, local/leap boundaries, snapshots, lifecycle/archive, roles/tenant/version, numeric currencies, dated reversals, lifecycle terms served end to end, append-only ficha amendments and preserved billing cadence`);
await pg.close();
