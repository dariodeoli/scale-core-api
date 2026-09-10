import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {financialForecast,forecastMonth,companyCurrency} from './forecast.js';
import {suite} from './agency-suite.js';
import {operations} from './operations.js';

const pg=new PGlite();
await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
for(const file of ['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql','20260910_productivity.sql','20260910_profile_identity.sql','20260910_currencies.sql','20260910_company_currency.sql']) {
 await pg.exec(await fs.readFile(new URL(`./migrations/${file}`,import.meta.url),'utf8'));
}
// Startup migrations must be repeatable.
await pg.exec(await fs.readFile(new URL('./migrations/20260910_company_currency.sql',import.meta.url),'utf8'));
const query=(sql,args)=>pg.query(sql,args),db={query,connect:async()=>({query,release(){}})};
const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
const other=(await query("insert into organizations(slug,name) values('forecast-other','Other') returning id")).rows[0].id;
const uid=(await query("insert into users(email,password_hash) values('forecast@example.invalid','unused') returning id")).rows[0].id;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,uid]);
const user={id:uid,organization_id:org,role:'owner'};
const client=(await query("insert into agency_clients(organization_id,name) values($1,'Forecast fixture') returning id",[org])).rows[0].id;
const otherClient=(await query("insert into agency_clients(organization_id,name) values($1,'Other fixture') returning id",[other])).rows[0].id;
let sent=0,number=0;
async function call(path,method='GET',payload={},as=user) {
 let result;
 const args={req:{method,socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://test'+path),db,session:async()=>as,body:async()=>payload,send:(_,status,data)=>{result={status,...data};},sendInvitation:async()=>{sent++;return true;}};
 const handler=path.startsWith('/api/agency/forecast')?financialForecast:/^\/api\/agency\/(collaborators|commissions)/.test(path)?operations:suite;
 assert.equal(await handler(args),true);
 return result;
}
async function budget({currency='USD',total=20,status='accepted',accepted='2026-09-10T12:00:00Z',organization=org,customer=client}={}) {
 return (await query('insert into agency_budgets(organization_id,client_id,number,title,currency,total,status,accepted_at) values($1,$2,$3,$4,$5,$6,$7,$8) returning id',[organization,customer,`Q-${++number}`,'Forecast fixture',currency,total,status,accepted])).rows[0].id;
}
async function invoice({currency='USD',total=100,status='issued',issued='2026-09-10',budgetId=null,organization=org,customer=client}={}) {
 return (await query('insert into agency_invoices(organization_id,client_id,number,currency,total,status,issued_on,budget_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning id',[organization,customer,`F-${++number}`,currency,total,status,issued,budgetId])).rows[0].id;
}
const path='/api/agency/forecast?month=2026-09';
assert.equal(forecastMonth(null,new Date('2026-10-01T02:59:59Z')),'2026-09');
assert.equal(forecastMonth(null,new Date('2026-10-01T03:00:00Z')),'2026-10');
for(const invalid of ['2026-00','2026-13','26-09','2026-09-01','','9999-01'])assert.throws(()=>forecastMonth(invalid));
assert.equal((await call(path,'GET',{},null)).status,401);
for(const role of ['management','sales','production','editor','viewer'])assert.equal((await call(path,'GET',{}, {...user,role})).status,403);
for(const role of ['owner','admin','finance'])assert.deepEqual((await call(path,'GET',{}, {...user,role})).records,[]);
assert.equal((await call(path,'POST')).status,405);
assert.equal((await call('/api/agency/forecast?month=2026-13')).status,400);

await invoice({total:100.10,issued:'2026-09-01'});
await invoice({total:25.20,status:'paid',issued:'2026-09-30'});
await invoice({total:10,status:'partial'});
await invoice({total:5,status:'overdue'});
await invoice({total:999,issued:'2026-08-31'});
await invoice({total:888,issued:'2026-10-01'});
await invoice({total:777,status:'cancelled'});
await invoice({total:666,status:'draft'});
const linked=await budget({total:50});await invoice({total:50,budgetId:linked});
const lastMonth=await budget({total:444});await invoice({total:444,budgetId:lastMonth,issued:'2026-08-31'});
const nextMonth=await budget({total:333});await invoice({total:333,budgetId:nextMonth,issued:'2026-10-01'});
const cancelled=await budget({total:222});await invoice({total:222,budgetId:cancelled,status:'cancelled'});
const draft=await budget({total:111});await invoice({total:111,budgetId:draft,status:'draft'});
await budget({total:30.10,accepted:'2026-09-01T03:00:00Z'});
await budget({total:40.20,accepted:'2026-10-01T02:59:59Z'});
await budget({total:999,accepted:'2026-09-01T02:59:59Z'});
await budget({total:888,accepted:'2026-10-01T03:00:00Z'});
await budget({total:1000,accepted:null});
for(const status of ['draft','sent','rejected','expired'])await budget({total:9999,status});
const archived=await budget({total:9999});
await query("insert into agency_archived_records(organization_id,kind,record_id) values($1,'budgets',$2)",[org,archived]);
await invoice({currency:'PYG',total:1000});
await budget({currency:'EUR',total:0});
await query("insert into agency_leads(organization_id,name,stage,amount,currency,probability) values($1,'Won opportunity','won',999999,'USD',100)",[org]);
await invoice({organization:other,customer:otherClient,total:1234});
await budget({organization:other,customer:otherClient,total:4321});
let result=await call(path+'&organization_id='+other);
assert.equal(result.status,200);
const usd=result.records.find(row=>row.currency==='USD');
assert.equal(Number(usd.issued_total),190.30);
assert.equal(Number(usd.accepted_uninvoiced_total),70.30);
assert.equal(Number(usd.expected_total),260.60);
assert.equal(usd.invoice_count,5);assert.equal(usd.budget_count,2);assert.equal(usd.undated_budget_count,1);
assert.equal(Number(result.records.find(row=>row.currency==='PYG').expected_total),1000);
assert.equal(Number(result.records.find(row=>row.currency==='EUR').expected_total),0);
assert.equal(Number((await call(path,'GET',{}, {...user,organization_id:other})).records[0].expected_total),5555);
assert.equal((await call('/api/agency/forecast?month=2026-11')).records[0].undated_budget_count,1);
await invoice({issued:'2024-02-29',total:0});
assert.equal((await call('/api/agency/forecast?month=2024-02')).records.find(r=>r.currency==='USD').invoice_count,1);
await budget({accepted:'2027-01-01T02:59:59Z',total:12});
assert.equal(Number((await call('/api/agency/forecast?month=2026-12')).records[0].expected_total),12);

assert.equal(await companyCurrency(db,other),'PYG');
assert.equal((await call('/api/agency/settings')).settings.default_currency,'PYG');
assert.equal((await call('/api/agency/settings','PATCH',{name:'Forecast company',legal_name:'Keep me',default_currency:'EUR'})).status,200);
for(const currency of ['PYG','USD','EUR','BRL','ARS','MXN']) {
 assert.equal((await call('/api/agency/settings','PATCH',{default_currency:currency})).default_currency,currency);
 assert.equal(await companyCurrency(db,org),currency);
}
assert.equal((await call('/api/agency/settings')).settings.legal_name,'Keep me');
assert.equal((await call('/api/agency/settings','PATCH',{name:'Name only'})).default_currency,'MXN');
for(const currency of ['GBP','eur','',null])assert.equal((await call('/api/agency/settings','PATCH',{default_currency:currency})).status,400);
for(const role of ['management','finance','sales','production','editor','viewer']){
 assert.equal((await call('/api/agency/settings','PATCH',{default_currency:'USD'},{...user,role})).status,403);
 assert.equal((await call('/api/agency/settings','GET',{}, {...user,role})).status,403);
}
assert.equal((await call('/api/agency/settings','PATCH',{default_currency:'BRL',organization_id:other})).status,200);
assert.equal(await companyCurrency(db,other),'PYG');
for(const kind of ['leads','inventory','plans']){
 const payload={name:'Default currency',items:[{description:'Fixture item',quantity:1,unitPrice:1}]};
 const created=await call(`/api/agency/${kind}`,'POST',payload);assert.equal(created.status,201);assert.equal(created.record.currency,'BRL');
 await call('/api/agency/settings','PATCH',{default_currency:'USD'});
 const edited=await call(`/api/agency/${kind}/${created.record.id}`,'PATCH',{name:'Existing record'});assert.equal(edited.record.currency,'BRL');
 const explicit=await call(`/api/agency/${kind}`,'POST',{...payload,currency:'ARS'});assert.equal(explicit.record.currency,'ARS');
 await call('/api/agency/settings','PATCH',{default_currency:'BRL'});
}
const person=await call('/api/agency/collaborators','POST',{full_name:'Currency fixture',compensation_amount:20});
assert.equal(person.status,201);assert.equal(person.collaborator.currency,'BRL');
await call('/api/agency/settings','PATCH',{default_currency:'MXN'});
assert.equal((await call(`/api/agency/collaborators/${person.collaborator.id}`,'PATCH',{full_name:'Still BRL'})).collaborator.currency,'BRL');
const commission=await call('/api/agency/commissions','POST',{kind:'referral',basis:'fixed',beneficiary_name:'Fixture',amount:10});
assert.equal(commission.status,201);assert.equal(commission.commission.currency,'MXN');
assert.equal((await query('select currency from agency_invoices where budget_id=$1',[linked])).rows[0].currency,'USD');
assert.equal(sent,0,'No external invitation sent');
await pg.close();
console.log('PASS: forecast dates, timezone, leap/year boundaries, exact totals, zero, no pipeline, invoice/budget dedup, cancelled/draft/archive exclusion, role and tenant isolation; six default currencies, partial settings, new versus existing records, no external writes');
