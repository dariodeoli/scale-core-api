import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {financialForecast,forecastMonth,companyCurrency} from './forecast.js';
import {suite} from './agency-suite.js';
import {operations} from './operations.js';
import {agencyReport,reports} from './reports.js';

const pg=new PGlite();
await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
for(const file of ['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql','20260910_productivity.sql','20260910_profile_identity.sql','20260910_client_lifecycle.sql','20260910_currencies.sql','20260910_company_currency.sql','20260911_agency_reports.sql','20260914_salary_forecast.sql','20260914_client_commercial_lifecycle.sql','20260914_client_terms_and_planned_expenses.sql']) {
 await pg.exec(await fs.readFile(new URL(`./migrations/${file}`,import.meta.url),'utf8'));
}
// Startup migrations must be repeatable.
await pg.exec(await fs.readFile(new URL('./migrations/20260910_company_currency.sql',import.meta.url),'utf8'));
await pg.exec(await fs.readFile(new URL('./migrations/20260914_salary_forecast.sql',import.meta.url),'utf8'));
await pg.exec(await fs.readFile(new URL('./migrations/20260914_client_terms_and_planned_expenses.sql',import.meta.url),'utf8'));
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
 const handler=path.startsWith('/api/agency/forecast')?financialForecast:/^\/api\/agency\/(collaborators|commissions)/.test(path)?operations:/^\/api\/agency\/(reports|clients\/\d+\/(reporting|commercial-terms)|planned-expenses)/.test(path)?reports:suite;
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
const invalidSalaryAmounts=[true,null,'','no es un importe','1250.5',1.5,0,-1,Number.MAX_SAFE_INTEGER+1];
assert.equal(forecastMonth(null,new Date('2026-10-01T02:59:59Z')),'2026-09');
assert.equal(forecastMonth(null,new Date('2026-10-01T03:00:00Z')),'2026-10');
for(const invalid of ['2026-00','2026-13','26-09','2026-09-01','','9999-01'])assert.throws(()=>forecastMonth(invalid));
assert.equal((await call(path,'GET',{},null)).status,401);
for(const role of ['management','sales','production','editor','viewer'])assert.equal((await call(path,'GET',{}, {...user,role})).status,403);
for(const role of ['owner','admin','finance'])assert.deepEqual((await call(path,'GET',{}, {...user,role})).records,[]);
assert.equal((await call(path,'POST')).status,405);
assert.equal((await call('/api/agency/forecast?month=2026-13')).status,400);
assert.equal((await call('/api/agency/collaborators','GET',{}, {...user,role:'viewer'})).status,403,'staff cannot read salary fields');
const salaryPyg=await call('/api/agency/collaborators','POST',{full_name:'Salario PYG',monthly_salary_amount:'1000',monthly_salary_currency:'PYG',started_on:'2026-09-01'});
const salaryUsd=await call('/api/agency/collaborators','POST',{full_name:'Salario USD',monthly_salary_amount:200,monthly_salary_currency:'USD',started_on:'2026-09-01'});
for(const amount of invalidSalaryAmounts)assert.equal((await call('/api/agency/collaborators','POST',{full_name:'Salario inválido',monthly_salary_amount:amount})).status,400,`base salary rejects ${String(amount)}`);
await call('/api/agency/collaborators','POST',{full_name:'Aún no inicia',monthly_salary_amount:'999',monthly_salary_currency:'PYG',started_on:'2026-10-01'});
await call('/api/agency/collaborators','POST',{full_name:'Ya finalizó',monthly_salary_amount:'888',monthly_salary_currency:'PYG',ended_on:'2026-08-31'});
assert.equal((await call(`/api/agency/collaborators/${salaryPyg.collaborator.id}/salary-overrides?month=2026-09`,'GET',{}, {...user,role:'viewer'})).status,403,'staff cannot read override notes');
for(const amount of invalidSalaryAmounts)assert.equal((await call(`/api/agency/collaborators/${salaryPyg.collaborator.id}/salary-overrides`,'PATCH',{month:'2026-09',amount})).status,400,`salary override rejects ${String(amount)}`);
assert.equal((await call(`/api/agency/collaborators/${salaryPyg.collaborator.id}/salary-overrides?month=2026-09`,'PATCH',{month:'2026-09',amount:'1250',note:'Ajuste puntual'})).override.amount,'1250');
assert.equal((await call(`/api/agency/collaborators/${salaryPyg.collaborator.id}/salary-overrides?month=2026-09`)).override.note,'Ajuste puntual');
let personnel=(await call(path)).personnel;
assert.equal(personnel.month,'2026-09');assert.equal(personnel.included_headcount,2);
const salaryPygRow=personnel.records.find(row=>row.currency==='PYG'),salaryUsdRow=personnel.records.find(row=>row.currency==='USD');
assert.deepEqual({headcount:salaryPygRow.included_headcount,baseCount:salaryPygRow.base_count,base:salaryPygRow.base_amount,overrideCount:salaryPygRow.override_count,override:salaryPygRow.override_amount,expense:salaryPygRow.expected_end_of_month_expense},{headcount:1,baseCount:0,base:0,overrideCount:1,override:1250,expense:1250});
assert.deepEqual({headcount:salaryUsdRow.included_headcount,baseCount:salaryUsdRow.base_count,base:salaryUsdRow.base_amount,overrideCount:salaryUsdRow.override_count,override:salaryUsdRow.override_amount,expense:salaryUsdRow.expected_end_of_month_expense},{headcount:1,baseCount:1,base:200,overrideCount:0,override:0,expense:200});

const financeId=(await query("insert into users(email,password_hash) values('forecast-finance@example.invalid','unused') returning id")).rows[0].id;
const managementId=(await query("insert into users(email,password_hash) values('forecast-management@example.invalid','unused') returning id")).rows[0].id;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'finance'),($1,$3,'management')",[org,financeId,managementId]);
const financeUser={id:financeId,organization_id:org,role:'finance'},managementUser={id:managementId,organization_id:org,role:'management'};
const commercialPlan=(await query("insert into agency_plans(organization_id,name,currency,items) values($1,'Plan recurrente','PYG','[]') returning id",[org])).rows[0].id;
const termsPath=`/api/agency/clients/${client}/commercial-terms`;
const terms={planId:String(commercialPlan),recurringAmount:'1000',currency:'PYG',startsOn:'2026-09-15',invoiceRequired:true,commissionRecipientId:String(salaryPyg.collaborator.id),commissionMode:'percentage',commissionValue:'10'};
assert.equal((await call(termsPath,'GET',{},financeUser)).terms,null,'finance can read an empty commercial profile');
assert.equal((await call(termsPath,'PATCH',terms,financeUser)).status,403,'finance is read-only for commercial terms');
for(const recurringAmount of [0,-1,'1000.5',true,Number.MAX_SAFE_INTEGER+1])assert.equal((await call(termsPath,'PATCH',{...terms,recurringAmount},managementUser)).status,400,`terms reject recurring amount ${String(recurringAmount)}`);
for(const commissionValue of [0,'10.5',101])assert.equal((await call(termsPath,'PATCH',{...terms,commissionValue},managementUser)).status,400,`terms reject commission ${String(commissionValue)}`);
let savedTerms=await call(termsPath,'PATCH',terms,managementUser);
assert.equal(savedTerms.status,200);assert.deepEqual({amount:savedTerms.terms.recurringAmount,currency:savedTerms.terms.currency,startsOn:savedTerms.terms.startsOn,invoiceRequired:savedTerms.terms.invoiceRequired,recipient:savedTerms.terms.commissionRecipientId,mode:savedTerms.terms.commissionMode,value:savedTerms.terms.commissionValue},{amount:1000,currency:'PYG',startsOn:'2026-09-15',invoiceRequired:true,recipient:String(salaryPyg.collaborator.id),mode:'percentage',value:10});
assert.deepEqual(Object.keys(savedTerms.terms).sort(),['clientId','commissionMode','commissionRecipientId','commissionRecipientName','commissionValue','currency','invoiceRequired','planId','planName','recurringAmount','startsOn','updatedAt'].sort(),'commercial terms response has the documented stable shape');
assert.equal((await call(termsPath,'GET',{},financeUser)).terms.planId,String(commercialPlan),'finance reads effective terms for LTV');

const expensesPath='/api/agency/planned-expenses?month=2026-09';
const recurringExpense={cadence:'recurring',effectiveMonth:'2026-08',category:'Software',amount:'300',currency:'PYG',note:'Licencias'};
const monthlyExpense={cadence:'monthly',effectiveMonth:'2026-09',category:'Producción',amount:200,currency:'USD',note:null};
assert.equal((await call(expensesPath,'POST',recurringExpense,{...user,role:'management'})).status,403,'only owner/admin/finance manage planned expenses');
for(const amount of [0,-1,'20.5',true,Number.MAX_SAFE_INTEGER+1])assert.equal((await call(expensesPath,'POST',{...recurringExpense,amount},financeUser)).status,400,`expenses reject amount ${String(amount)}`);
const recurringCreated=await call(expensesPath,'POST',recurringExpense,financeUser);const monthlyCreated=await call(expensesPath,'POST',monthlyExpense,financeUser);
assert.equal(recurringCreated.status,201);assert.equal(monthlyCreated.status,201);
const octoberCreated=await call(expensesPath,'POST',{...monthlyExpense,effectiveMonth:'2026-10',category:'Sólo octubre'},financeUser);assert.equal(octoberCreated.status,201);
const septemberExpenses=await call(expensesPath,'GET',{},financeUser);
assert.deepEqual(septemberExpenses.totals,[{currency:'PYG',amount:300},{currency:'USD',amount:200}],'selected month includes recurrence and only its monthly expense');
assert.equal((await call('/api/agency/planned-expenses?month=2026-10','GET',{},financeUser)).records.some(expense=>expense.category==='Sólo octubre'),true,'selected month includes its own monthly expense');
assert.deepEqual(recurringCreated.expense,{id:recurringCreated.expense.id,cadence:'recurring',effectiveMonth:'2026-08-01',category:'Software',amount:300,currency:'PYG',note:'Licencias'},'POST returns the stable expense shape');
assert.equal((await call(`/api/agency/planned-expenses/${recurringCreated.expense.id}`,'PATCH',{...recurringExpense,amount:'350'},financeUser)).expense.amount,350);
assert.equal((await call(`/api/agency/planned-expenses/${monthlyCreated.expense.id}`,'DELETE',{},financeUser)).deleted,true);
assert.equal(Number((await query("select count(*)::int as n from agency_operation_audit where organization_id=$1 and table_name='agency_planned_expenses'",[org])).rows[0].n)>=4,true,'planned expense changes are audited');

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
const paidInvoice=await invoice({currency:'PYG',total:1000});
const paymentAccount=(await query("insert into bank_accounts(organization_id,name,account_type,currency) values($1,'Cobros PYG','bank','PYG') returning id",[org])).rows[0].id;
await query("insert into agency_payments(organization_id,invoice_id,account_id,amount,received_on,reference) values($1,$2,$3,500,'2026-09-20','Cobro de prueba')",[org,paidInvoice,paymentAccount]);
await budget({currency:'EUR',total:0});
await query("insert into agency_leads(organization_id,name,stage,amount,currency,probability) values($1,'Won opportunity','won',999999,'USD',100)",[org]);
await invoice({organization:other,customer:otherClient,total:1234});
await budget({organization:other,customer:otherClient,total:4321});
let result=await call(path+'&organization_id='+other);
assert.equal(result.status,200);
assert.deepEqual(result.contracted_recurring.records,[{currency:'PYG',client_count:1,amount:1000}],'contracted recurring revenue comes only from commercial terms');
assert.deepEqual(result.commission_forecast.records,[{currency:'PYG',client_count:1,amount:100}],'commission forecast stays separate from revenue');
assert.deepEqual(result.collected_actual.records,[{currency:'PYG',amount:500}],'actual collections are separate from agreements and invoices');
assert.deepEqual(result.planned_expenses.records,[{currency:'PYG',expense_count:1,amount:350}],'planned recurring expense uses the selected month');
const usd=result.records.find(row=>row.currency==='USD');
assert.deepEqual({issued:usd.issued_total,accepted:usd.accepted_uninvoiced_total,expected:usd.expected_total},{issued:190,accepted:70,expected:261},'forecast projects legacy decimal aggregates to whole safe integers');
assert.equal(usd.invoice_count,5);assert.equal(usd.budget_count,2);assert.equal(usd.undated_budget_count,1);
assert.equal(result.records.find(row=>row.currency==='PYG').expected_total,2000);
assert.equal(result.records.find(row=>row.currency==='EUR').expected_total,0);
assert.equal((await call(path,'GET',{}, {...user,organization_id:other})).records[0].expected_total,5555);
const historical=(await agencyReport(db,org,{month:'2026-09',months:1},new Date('2026-10-01T03:00:00Z'))).months[0].financial;
for(const entry of historical)for(const key of ['invoiced','collected','averageTicket','averageRevenuePerClient'])assert.equal(Number.isSafeInteger(entry[key]),true,`historical ${key} is a safe whole integer`);
assert.equal(historical.find(entry=>entry.currency==='USD').invoiced,190,'historical invoiced aggregation uses the same projection');
assert.equal((await query("select sum(total)::text as total from agency_invoices where organization_id=$1 and currency='USD' and issued_on>='2026-09-01' and issued_on<'2026-10-01' and status in ('issued','partial','paid','overdue')",[org])).rows[0].total,'190.30','response projection does not rewrite historical invoice values');
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
console.log('PASS: forecast dates, timezone, salary authorization and month overrides, commercial-term role and integer validation, auditable planned-expense recurrence, revenue/payment segregation, leap/year boundaries, exact totals, zero, no pipeline, invoice/budget dedup, cancelled/draft/archive exclusion, role and tenant isolation; six default currencies, partial settings, new versus existing records, no external writes');
