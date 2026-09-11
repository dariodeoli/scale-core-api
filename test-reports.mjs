import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {reports,agencyReport,reportingPeriod} from './reports.js';
import {recordLifecycle} from './record-lifecycle.js';
import {suite} from './agency-suite.js';

const pg=new PGlite();
await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
for(const name of ['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql','20260910_productivity.sql','20260910_client_links.sql','20260910_client_lifecycle.sql'])await pg.exec(await fs.readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8'));
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
for(const role of ['management','sales','production','editor','viewer'])assert.equal((await call('/api/agency/reports','GET',{}, {...user,role})).status,403);
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
assert.equal(usd.invoiced,'300.30');assert.equal(usd.collected,'30.10');assert.equal(usd.invoiceCount,3);assert.equal(usd.billedClients,2);assert.equal(usd.averageTicket,'100.10');assert.equal(usd.averageRevenuePerClient,'150.15');
assert.equal(financial.months[0].financial.find(f=>f.currency==='PYG').invoiced,'50000.00');
assert.equal(financial.months[1].financial[0].collected,'-30.10');assert.equal(financial.months[2].financial[0].invoiced,'0.00');assert.equal(financial.months[2].financial[0].averageTicket,'0.00');
await call(`/api/agency/clients/${client.id}`,'DELETE',{}, {...user,organization_id:fresh},recordLifecycle);
assert.deepEqual((await agencyReport(db,fresh,{month:'2024-04',months:3},fixed)).months.map(m=>m.financial),financial.months.map(m=>m.financial));
assert.deepEqual((await agencyReport(db,org,{month:'2024-02',months:1},fixed)).months[0].financial,[],'no tenant financial leakage');
const receiptOnly=await invoice(c2,{date:'2024-01-01',total:'10.00'});
await query("insert into agency_payments(organization_id,invoice_id,account_id,amount,received_on) values($1,$2,$3,'10.00','2024-05-01')",[fresh,receiptOnly,account]);
const zero=(await agencyReport(db,fresh,{month:'2024-05',months:1},new Date('2024-06-01T04:00:00Z'))).months[0].financial[0];
assert.equal(zero.invoiceCount,0);assert.equal(zero.billedClients,0);assert.equal(zero.averageTicket,null);assert.equal(zero.averageRevenuePerClient,null);assert.equal(zero.collected,'10.00');
// Existing lifecycle PATCH must still run both updates and produce a final truthful state.
const patched=await call(`/api/agency/clients/${legacy}`,'PATCH',{name:'Existing client',lifecycle_status:'paused'},user,suite);
assert.equal(patched.status,200);
const last=await one('select * from agency_client_reporting_events where client_id=$1 order by event_at desc,id desc limit 1',[legacy]);assert.equal(last.lifecycle_status,'paused');assert.equal(last.active,false);
console.log(`PASS reports: ${n} real handler calls; migration repeatability, observation coverage, local/leap boundaries, snapshots, lifecycle/archive, roles/tenant/version, numeric currencies and dated reversals`);
await pg.close();
