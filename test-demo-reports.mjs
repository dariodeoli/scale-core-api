import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {seedDemoReports} from './demo-reports.js';
import {seedPrivateDemo} from './demo-session.js';
import {agencyReport} from './reports.js';

// In-memory PostgreSQL only. Never read credentials or connect to a live API/DB.
const pg=new PGlite(),originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error('Network forbidden in demo report fixtures');};
const query=(sql,args)=>pg.query(sql,args),c={query};
const source=await fs.readFile(new URL('./demo-reports.js',import.meta.url),'utf8');
assert(!/alter table|disable trigger|delete from|update agency_payments|update bank_accounts/i.test(source));
assert.equal((source.match(/export /g)||[]).length,1);
const init=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
const start=init.indexOf('async function init()'),end=init.indexOf("await migration.query('commit')",start);
const migrations=[...new Set([...init.slice(start,end).matchAll(/(2026\d{4}_[a-z0-9_]+\.sql)/g)].map(match=>match[1]).filter(file=>file!=='20260908_dadoo_hub.sql'))];
assert(migrations.includes('20260911_agency_reports.sql'));
const prefix='DEMO-REPORTS-V1';
const tableNames=['agency_clients','agency_plans','agency_invoices','agency_payments','bank_accounts','account_transfers','agency_payouts','agency_client_reporting_events','agency_reporting_coverage','agency_operation_audit'];
// JSON renders timestamptz in the connection timezone. Compare instants, not
// display offsets, when proving that fixture-local SET LOCAL did not mutate data.
const canonicalRows=rows=>rows.map(({row})=>({row:JSON.stringify(JSON.parse(row,(_key,value)=>
 typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)?new Date(value).toISOString():value))}));
const snapshot=async org=>Object.fromEntries(await Promise.all(tableNames.map(async table=>[table,canonicalRows((await query(`select to_jsonb(t)::text row from ${table} t where organization_id=$1 order by to_jsonb(t)::text`,[org])).rows)])));
const user=async label=>(await query("insert into users(email,password_hash) values($1,'!fixture-no-login') returning id",[label+'@demo.example.invalid'])).rows[0].id;
const organization=async(slug,owner=null,sourceId=null)=>(await query('insert into organizations(slug,name,demo_owner_user_id,demo_source_id,demo_expires_at) values($1,\'Agencia Horizonte\',$2,$3,now()+interval \'1 day\') returning id',[slug,owner,sourceId])).rows[0].id;
const member=(org,uid)=>query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,uid]);
const now=async()=>(await query('select clock_timestamp() as at')).rows[0].at;
const report=async org=>agencyReport(c,org,{months:7},await now());

try{
 await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
 await pg.exec("set timezone to 'UTC'");
 for(const migration of migrations)await pg.exec(await fs.readFile(new URL('./migrations/'+migration,import.meta.url),'utf8'));
 await pg.exec('begin');
 const owner=await user('report-owner'),otherOwner=await user('other-owner');
 const real=(await query("select id from organizations where slug='scale'")).rows[0].id;
 const template=await organization('scale-demo-controles-20260908');
 await member(real,owner);await member(template,owner);
 const realBefore=await snapshot(real),templateBefore=await snapshot(template);
 const org=await organization('demo-session-report-fixture',owner,template);await member(org,owner);
 let before,currentBefore,accountsBefore,eventsBefore;
 // Capture the existing current-month seed at the exact integration boundary.
 const observed={query:async(sql,args)=>{
  if(sql==='savepoint demo_reports_v1'&&!before){
   before=await snapshot(org);currentBefore=(await report(org)).months.at(-1);
   accountsBefore=(await query('select id,balance::text from bank_accounts where organization_id=$1 order by id',[org])).rows;
   eventsBefore=(await query('select to_jsonb(e)::text row,id from agency_client_reporting_events e where organization_id=$1 order by id',[org])).rows;
  }
  return query(sql,args);
 }};
 await seedPrivateDemo(observed,org,owner);assert(before,'main seed must invoke the isolated report builder');
 assert.equal((await query('show timezone')).rows[0].TimeZone,'America/Asuncion','seed aligns original and historic invoice dates to the report timezone');
 const completed=await snapshot(org),reports=await report(org);
 const dates=(await query("select to_char(date_trunc('month',current_date)+n*interval '1 month','YYYY-MM') as month from generate_series(-6,0) n order by n")).rows.map(row=>row.month);
 assert.deepEqual(reports.months.map(month=>month.month),dates,'six complete months and current month, from SQL current_date');
 assert.deepEqual(reports.months.map(month=>month.clients.active),[4,6,7,10,13,18,20]);
 assert.deepEqual(reports.months.map(month=>month.clients.added),[4,2,2,2,4,4,2],'automatic created-NOW events must not count a second acquisition');
 assert.deepEqual(reports.months.map(month=>month.clients.lost),[0,0,1,0,1,0,0]);
 assert(reports.months.slice(0,6).every(month=>month.isPartial===false));
 assert.equal(reports.months.at(-1).isPartial,true);
 assert.deepEqual(reports.months.at(-1).financial,currentBefore.financial,'existing current-month invoicing/receipts unchanged');
 assert.equal(reports.months.at(-1).clients.active,currentBefore.clients.active);
 assert.equal(reports.months.at(-1).clients.tenureKnown,20);
 assert.equal(reports.months.at(-1).clients.plans.length,4);
 assert.equal(reports.months.at(-1).clients.types.length,4);
 assert.equal(reports.months[2].clients.retentionPercent,83.33);
 assert.equal(reports.months[4].clients.retentionPercent,90);
 for(const month of reports.months.slice(0,6)){
  assert(month.clients.averageTenureDays>0);
  for(const money of month.financial){
   assert.equal(money.invoiced,money.collected,'historical fixture invoices are fully paid');
   assert.equal(money.invoiceCount,money.billedClients,'one invoice per active client/month');
  }
 }

 const added=(await query('select count(*)::int n from agency_invoices where organization_id=$1 and number like $2',[org,prefix+'-%'])).rows[0].n;
 assert.equal(added,58);
 assert.equal((await query('select count(*)::int n from agency_payments where organization_id=$1 and request_key like $2',[org,prefix+'-%'])).rows[0].n,58);
 assert.equal((await query('select count(*)::int n from agency_client_reporting_events where organization_id=$1',[org])).rows[0].n,64,'20 original + 20 current metadata + 24 historical snapshots');
 const originals=async table=>(await query(`select to_jsonb(t)::text row from ${table} t where organization_id=$1 and ${table==='agency_invoices'?'number not like $2':'coalesce(request_key,\'\') not like $2'} order by to_jsonb(t)::text`,[org,prefix+'-%'])).rows;
 assert.deepEqual(canonicalRows(await originals('agency_invoices')),before.agency_invoices);
 assert.deepEqual(canonicalRows(await originals('agency_payments')),before.agency_payments,'original receipts are immutable and identical');
 assert.deepEqual((await query('select to_jsonb(e)::text row,id from agency_client_reporting_events e where organization_id=$1 and id=any($2::bigint[]) order by id',[org,eventsBefore.map(row=>row.id)])).rows,eventsBefore,'never rewrite original events');
 for(const account of accountsBefore){
  const balance=(await query(`select (a.balance-coalesce((select sum(p.amount) from agency_payments p
    where p.organization_id=a.organization_id and p.account_id=a.id and p.request_key like $3),0))::text as original
    from bank_accounts a where organization_id=$1 and id=$2`,[org,account.id,prefix+'-%'])).rows[0].original;
  assert.equal(balance,account.balance,'new receipts alone explain each account delta');
 }
 assert.equal((await query(`select count(*)::int n from bank_accounts a where a.organization_id=$1 and a.balance<>
  coalesce((select sum(m.amount) from agency_cash_movements m where m.organization_id=a.organization_id and m.account_id=a.id),0)`,[org])).rows[0].n,0,'all balances reconcile to receipts, payouts and transfers');
 assert.equal((await query(`select count(*)::int n from agency_invoices i join agency_payments p on p.invoice_id=i.id and p.organization_id=i.organization_id
  join bank_accounts a on a.id=p.account_id and a.organization_id=i.organization_id
  where i.organization_id=$1 and i.number like $2 and
  (i.issued_on>=date_trunc('month',current_date)::date or i.issued_on<(date_trunc('month',current_date)-interval '6 months')::date
   or date_trunc('month',i.issued_on)<>date_trunc('month',p.received_on) or i.currency<>a.currency
   or i.total<>p.amount or i.status<>'paid' or i.paid_amount<>i.total)`,[org,prefix+'-%'])).rows[0].n,0);
 assert.equal((await query(`select count(*)::int n from agency_invoices i join agency_invoices current_invoice
  on current_invoice.organization_id=i.organization_id and current_invoice.client_id=i.client_id and current_invoice.number not like $2
  where i.organization_id=$1 and i.number like $2 and (i.currency<>current_invoice.currency or i.total<>current_invoice.total)`,[org,prefix+'-%'])).rows[0].n,0,'no repricing or currency conversion');
 assert.equal((await query(`select count(*)::int n from agency_invoices i join lateral
  (select active,lifecycle_status from agency_client_reporting_events e where e.organization_id=i.organization_id and e.client_id=i.client_id
   and e.event_at<=i.issued_on::timestamp at time zone 'America/Asuncion' order by event_at desc,id desc limit 1) e on true
  where i.organization_id=$1 and i.number like $2 and (not e.active or e.lifecycle_status<>'active')`,[org,prefix+'-%'])).rows[0].n,0,'paused months have no fixture invoice');
 assert.equal((await query(`select count(*)::int n from agency_clients c join agency_plans p on p.id=c.service_plan_id
  where c.organization_id=$1 and p.organization_id<>c.organization_id`,[org])).rows[0].n,0);
 assert.deepEqual(await seedDemoReports(c,{organizationId:org,userId:owner}),{seeded:false});
 assert.deepEqual(await snapshot(org),completed,'repeated seeding is a complete no-op');
 await pg.exec('commit');
 assert.equal((await query('show timezone')).rows[0].TimeZone,'UTC','fixture timezone does not leak beyond the transaction');
 await pg.exec('begin');
 assert.deepEqual(await seedDemoReports(c,{organizationId:org,userId:owner}),{seeded:false},'completion marker survives commit');
 await assert.rejects(()=>seedDemoReports(c,{organizationId:real,userId:owner}),{status:403});
 await assert.rejects(()=>seedDemoReports(c,{organizationId:template,userId:owner}),{status:403});
 await assert.rejects(()=>seedDemoReports(c,{organizationId:org,userId:otherOwner}),{status:403});
 assert.deepEqual(await snapshot(real),realBefore);assert.deepEqual(await snapshot(template),templateBefore);
 const stale=await organization('demo-session-old-fixture',owner);await member(stale,owner);
 await query("update organizations set created_at=now()-interval '1 day' where id=$1",[stale]);
 const staleBefore=await snapshot(stale);
 await assert.rejects(()=>seedDemoReports(c,{organizationId:stale,userId:owner}),{status:409});
 assert.deepEqual(await snapshot(stale),staleBefore);
 const opened=await organization('demo-session-opened-fixture',owner);await member(opened,owner);
 await query("insert into agency_demo_sessions(demo_key,user_id,organization_id) values('already-opened',$1,$2)",[owner,opened]);
 await assert.rejects(()=>seedDemoReports(c,{organizationId:opened,userId:owner}),{status:409});
 const publicOpened=await organization('demo-session-public-opened',owner);await member(publicOpened,owner);
 await query("insert into sessions(id,user_id,organization_id,expires_at) values('public-opened-session',$1,$2,now()+interval '1 day')",[owner,publicOpened]);
 await assert.rejects(()=>seedDemoReports(c,{organizationId:publicOpened,userId:owner}),{status:409});

 // Fail halfway through actual receipt insertion. The seed's savepoint restores
 // clients, events, coverage, invoices, audit rows AND trigger-maintained balances.
 const retry=await organization('demo-session-retry-fixture',otherOwner);await member(retry,otherOwner);
 let baseline,failAt=0;
 const failing={query:async(sql,args)=>{
  if(sql==='savepoint demo_reports_v1'&&!baseline)baseline=await snapshot(retry);
  if(sql.includes('insert into agency_payments')&&String(args?.[7]).startsWith(prefix)&&++failAt===3)throw Error('Fixture transport failure');
  return query(sql,args);
 }};
 await assert.rejects(()=>seedPrivateDemo(failing,retry,otherOwner),/Fixture transport failure/);
 assert.deepEqual(await snapshot(retry),baseline,'partial seed fully rolled back');
 assert.deepEqual(await seedDemoReports(c,{organizationId:retry,userId:otherOwner}),{seeded:true,invoiceCount:58,paymentCount:58,eventCount:24});
 const retryReport=await report(retry);
 assert.deepEqual(retryReport.months.map(month=>month.financial),reports.months.map(month=>month.financial),'each visitor gets their own equivalent financial fixture');
 assert.deepEqual(await snapshot(org),completed,'other visitor seeding cannot change the first demo');
 assert.deepEqual(await snapshot(real),realBefore);assert.deepEqual(await snapshot(template),templateBefore);
 await assert.rejects(()=>seedDemoReports({query(){assert.fail('invalid IDs must not reach SQL');}},{organizationId:'1;drop',userId:owner}),{status:400});
 await pg.exec('commit');
 await assert.rejects(()=>seedDemoReports(c,{organizationId:org,userId:owner}),/SAVEPOINT can only be used in transaction blocks/i);
 console.log('PASS: new-demo-only report fixtures; 7 dynamic months, 58 invoices/58 receipts, 24 append-only historical events, first-created growth, tenant isolation, unchanged current receipts, trigger-balanced accounts, atomic retry and persistent idempotency. In-memory PostgreSQL only.');
}finally{
 globalThis.fetch=originalFetch;
 await pg.close();
}
