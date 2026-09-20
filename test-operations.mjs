import assert from 'node:assert/strict';
import {identitySchema} from './scripts/test-identity-schema.mjs';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {operations} from './operations.js';
import {roleCan} from './permissions.js';
import sharp from 'sharp';
const pg=new PGlite();
await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
for(const file of ['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_client_payment_status.sql','20260914_client_commercial_lifecycle.sql','20260914_client_terms_and_planned_expenses.sql','20260914_role_permissions.sql','20260915_optional_commission_terms.sql','20260915_client_invoice_flags.sql'])await pg.exec(await fs.readFile(new URL(`./migrations/${file}`,import.meta.url),'utf8'));
for(const file of ['20260910_productivity.sql','20260910_profile_identity.sql','20260912_comment_mentions.sql'])await pg.exec(await fs.readFile(new URL(`./migrations/${file}`,import.meta.url),'utf8'));
for(const file of ['20260910_currencies.sql','20260910_company_currency.sql','20260914_salary_forecast.sql','20260915_salary_override_signed.sql'])await pg.exec(await fs.readFile(new URL(`./migrations/${file}`,import.meta.url),'utf8'));
await identitySchema(pg);
const sql=(s,v)=>pg.query(s,v);
const org=(await sql("select id from organizations where slug='scale'")).rows[0].id;
const other=(await sql("insert into organizations(slug,name) values('test-other','Other') returning id")).rows[0].id;
const uid=(await sql("insert into users(email,password_hash) values('qa@example.invalid','unused') returning id")).rows[0].id;
const user={id:uid,organization_id:org,role:'owner'};
await sql("insert into organization_members values($1,$2,'owner',now())",[org,uid]);
const client=(await sql("insert into agency_clients(name,organization_id) values('Test',$1) returning id",[org])).rows[0].id;
const project=(await sql("insert into agency_projects(name,client_id,organization_id) values('Project',$1,$2) returning id",[client,org])).rows[0].id;
const invoice=(await sql("insert into agency_invoices(organization_id,client_id,number,total,paid_amount) values($1,$2,'TEST',1000,400) returning id",[org,client])).rows[0].id;
const account=(await sql("insert into bank_accounts(organization_id,name,account_type,balance) values($1,'Cash','cash',1000) returning id",[org])).rows[0].id;
const wrongAccount=(await sql("insert into bank_accounts(organization_id,name,account_type,balance) values($1,'Other','cash',1000) returning id",[other])).rows[0].id;
async function call(path,method='GET',payload={},as=user){let response;await operations({req:{method,socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL(`https://test${path}`),db:{connect:async()=>({query:sql,release(){}})},session:async()=>as,body:async()=>payload,send:(_,status,data)=>response={status,...data}});return response;}
const {agencyCore}=await import('./agency-core.js');
async function coreCall(path,as=user){let response;const handled=await agencyCore({req:{method:'GET',socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://test'+path),db:{query:sql,connect:async()=>({query:sql,release(){}})},session:async()=>as,body:async()=>({}),send:(_,status,data)=>response={status,...data}});assert.equal(handled,true,`${path} is handled by agency-core`);return response;}
// Custodians stay behind accounts.manage: finance reads them for treasury, nobody else.
assert.equal((await coreCall('/api/agency/custodians')).status,200,'owner reads custodians');
for(const role of ['admin','finance'])assert.equal((await coreCall('/api/agency/custodians',{...user,role})).status,200,`${role} reads custodians for treasury`);
for(const role of ['management','sales','production','editor','viewer','collaborator'])assert.equal((await coreCall('/api/agency/custodians',{...user,role})).status,403,`custodians stay behind accounts.manage for ${role}`);
const person={full_name:'QA Person',email:'qa@example.invalid',compensation_type:'fixed',compensation_amount:100,currency:'PYG',payment_day:5,started_on:'2026-09-01'};
let r=await call('/api/agency/collaborators','POST',person);assert.equal(r.status,201);const pid=r.collaborator.id;
r=await call(`/api/agency/collaborators/${pid}`,'PATCH',{...person,job_title:'Editor'});assert.equal(r.collaborator.job_title,'Editor');
assert.equal((await call('/api/agency/collaborators','GET',{}, {...user,role:'viewer'})).status,403);
assert.equal((await call('/api/agency/collaborators','GET',{}, {...user,organization_id:other})).collaborators.length,0);
assert.equal((await call(`/api/agency/collaborators/${pid}`,'PATCH',person,{...user,organization_id:other})).status,404);
r=await call(`/api/agency/projects/${project}/comments`,'POST',{body:'Follow up'});assert.equal(r.status,201);
assert.equal((await call(`/api/agency/projects/${project}/comments`)).comments[0].author_email,'qa@example.invalid');
assert.equal((await call(`/api/agency/projects/${project}/comments`,'POST',{body:'Blocked'},{...user,role:'viewer'})).status,403);
assert.equal((await call(`/api/agency/projects/${project}/comments`,'GET',{}, {...user,organization_id:other})).status,404);
r=await call('/api/agency/commissions','POST',{beneficiary_name:'QA referral',kind:'referral',basis:'collected',percentage:10,amount:0,currency:'PYG',invoice_id:invoice,collaborator_id:pid});assert.equal(r.status,201);assert.equal(Number(r.commission.amount),40);const cid=r.commission.id;
assert.equal((await call('/api/agency/payouts','POST',{commission_id:cid,account_id:account,amount:40,reference:'TEST',paid_on:'2026-09-08'})).status,409);
assert.equal((await call(`/api/agency/commissions/${cid}`,'PATCH',{status:'approved'})).status,200);
assert.equal((await call('/api/agency/payouts','POST',{commission_id:cid,account_id:wrongAccount,amount:40,reference:'TEST',paid_on:'2026-09-08'})).status,400);
r=await call('/api/agency/payouts','POST',{commission_id:cid,account_id:account,amount:999,reference:'TEST',paid_on:'2026-09-08'});assert.equal(r.status,201);assert.equal(Number(r.payout.amount),40);
assert.equal((await call('/api/agency/payouts','POST',{commission_id:cid,account_id:account,amount:40,reference:'TEST',paid_on:'2026-09-08'})).status,409);
assert.equal(Number((await sql('select balance from bank_accounts where id=$1',[account])).rows[0].balance),960);
assert.equal((await call('/api/agency/payouts','POST',{collaborator_id:pid,account_id:account,amount:2000,reference:'TEST',paid_on:'2026-09-08'})).status,400);
assert.equal((await call('/api/agency/payouts','POST',{collaborator_id:pid,account_id:account,amount:100,reference:'TEST pay',paid_on:'2026-09-08'})).status,201);
assert.equal(Number((await sql('select balance from bank_accounts where id=$1',[account])).rows[0].balance),860);
assert.equal((await call('/api/agency/commissions')).commissions[0].status,'paid');
assert.equal((await call('/api/agency/payouts')).payouts.length,2);
// Monthly commission settlement by collaborator.
assert.equal((await call('/api/agency/commissions/monthly','GET',{}, {...user,role:'viewer'})).status,403,'monthly commissions follow commissions.manage');
assert.equal((await call('/api/agency/commissions/monthly?month=2026-13','GET')).status,400,'monthly commissions validate the month format');
assert.equal((await call('/api/agency/commissions/monthly?month=2026-08','GET',{}, {...user,role:'finance'})).status,200);
const settlePerson=(await call('/api/agency/collaborators','POST',{full_name:'Monthly settle',email:'settle@example.invalid',compensation_type:'fixed',compensation_amount:0,currency:'PYG',started_on:'2026-07-01'})).collaborator;
const settleClient=(await sql("insert into agency_clients(name,organization_id) values('Settlement',$1) returning id",[org])).rows[0].id;
await sql("insert into agency_client_commercial_terms(organization_id,client_id,plan_id,recurring_amount,currency,starts_on,invoice_required,commission_recipient_id,commission_mode,commission_value) values($1,$2,null,1000,'PYG','2026-07-01',true,$3,'percentage',10)",[org,settleClient,settlePerson.id]);
const settleInvoice=(await sql("insert into agency_invoices(organization_id,client_id,number,total,paid_amount,status,issued_on) values($1,$2,'SETTLE',500,0,'issued','2026-08-05') returning id",[org,settleClient])).rows[0].id;
for(const [status,amount] of [['pending',50],['approved',30],['paid',20],['cancelled',99]])await sql("insert into agency_commissions(organization_id,invoice_id,collaborator_id,kind,beneficiary_name,amount,currency,status,due_on) values($1,$2,$3,'sales',$4,$5,'PYG',$6,'2026-08-20')",[org,settleInvoice,settlePerson.id,`Settle ${status}`,amount,status]);
const settlement=await call('/api/agency/commissions/monthly?month=2026-08');
assert.equal(settlement.status,200);assert.equal(settlement.month,'2026-08');
const settleRow=settlement.records.find(row=>String(row.recipient_id)===String(settlePerson.id)&&row.currency==='PYG');
assert.ok(settleRow,'percentage terms and commissions group to their recipient');
assert.equal(settleRow.name,'Monthly settle');
assert.equal(Number(settleRow.expected_amount),100,'percentage over contracted monthly amount');
assert.equal(Number(settleRow.recorded_amount),100,'cancelled commissions stay out of the settlement');
assert.equal(Number(settleRow.pending_amount),50);
assert.equal(Number(settleRow.approved_amount),30);
assert.equal(Number(settleRow.paid_amount),20);
assert.equal((await call('/api/agency/commissions/monthly?month=2026-08','GET',{}, {...user,organization_id:other})).records.length,0,'monthly commissions keep tenant isolation');
assert.ok((await sql('select * from agency_operation_audit where actor=$1',[String(uid)])).rows.length>=5);
r=await call('/api/agency/referral-discounts','POST',{invoice_id:invoice,amount:500,referrer:'Referral client',reason:'Reward'});assert.equal(r.status,201);const did=r.discount.id;
assert.equal(Number((await sql('select total from agency_invoices where id=$1',[invoice])).rows[0].total),500);
assert.equal((await call('/api/agency/referral-discounts','POST',{invoice_id:invoice,amount:150,referrer:'Referral client',reason:'Reward'})).status,400);
assert.equal((await call('/api/agency/referral-discounts','GET',{}, {...user,organization_id:other})).discounts.length,0);
assert.equal((await call(`/api/agency/referral-discounts/${did}`,'PATCH',{})).status,200);
assert.equal((await call(`/api/agency/referral-discounts/${did}`,'PATCH',{})).status,409);
assert.equal(Number((await sql('select total from agency_invoices where id=$1',[invoice])).rows[0].total),1000);
await assert.rejects(()=>sql('insert into agency_payments(organization_id,invoice_id,account_id,amount) values($1,$2,$3,700)',[org,invoice,account]));
await assert.rejects(()=>sql('insert into account_transfers(organization_id,from_account_id,to_account_id,amount) values($1,$2,$3,10)',[org,account,wrongAccount]));
// Payment status view distinguishes invoiced clients from never-invoiced ones.
const serverSource=await fs.readFile(new URL('./agency-core.js',import.meta.url),'utf8');
function between(start,end){
 const a=serverSource.indexOf(start),b=serverSource.indexOf(end,a+start.length);
 assert(a>=0&&b>a,`Server test anchor missing: ${start}`);
 assert.equal(serverSource.indexOf(start,a+start.length),-1,`Ambiguous anchor: ${start}`);
 return serverSource.slice(a,b);
}
const paymentRoute=between("    if (url.pathname === '/api/agency/client-payment-status' && req.method === 'GET') {","    if (url.pathname === '/api/agency/clients' && req.method === 'GET') {");
const paymentStatusHandler=new Function('url','req','res','session','roleCan','send','db',`return (async()=>{${paymentRoute}})()`);
async function paymentStatusCall(as=user,status=null){
 let response;
 const url=new URL(`https://test/api/agency/client-payment-status${status?`?status=${status}`:''}`);
 await paymentStatusHandler(url,{method:'GET'},{},async()=>as,(u,c)=>roleCan(u,c),(res,code,data)=>{response={status:code,...data};},{query:sql});
 return response;
}
const invoicedClient=(await sql("insert into agency_clients(name,organization_id) values('Invoiced',$1) returning id",[org])).rows[0].id;
await sql("insert into agency_invoices(organization_id,client_id,number,total,paid_amount,status) values($1,$2,'INV-ISSUED',1000,0,'issued')",[org,invoicedClient]);
const draftOnlyClient=(await sql("insert into agency_clients(name,organization_id) values('Draft only',$1) returning id",[org])).rows[0].id;
await sql("insert into agency_invoices(organization_id,client_id,number,total,paid_amount,status) values($1,$2,'INV-DRAFT',500,0,'draft')",[org,draftOnlyClient]);
const neverInvoicedClient=(await sql("insert into agency_clients(name,organization_id) values('Never invoiced',$1) returning id",[org])).rows[0].id;
const paymentStatus=await paymentStatusCall();
assert.equal(paymentStatus.status,200);
const payRow=id=>paymentStatus.clients.find(row=>String(row.client_id)===String(id));
assert.equal(payRow(invoicedClient).has_invoice,true);
assert.equal(Number(payRow(invoicedClient).invoice_count),1);
assert.equal(payRow(draftOnlyClient).has_invoice,false);
assert.equal(Number(payRow(draftOnlyClient).invoice_count),0);
assert.equal(payRow(neverInvoicedClient).has_invoice,false);
assert.equal(Number(payRow(neverInvoicedClient).invoice_count),0);
assert.equal((await paymentStatusCall({...user,role:'viewer'})).status,403);
// Minimal profiles invite only a basic member and never overwrite existing permissions.
r=await call('/api/agency/job-roles');assert.ok(r.roles.length>=12);const job=r.roles[0];
r=await call('/api/agency/collaborators','POST',{full_name:'Minimal profile',email:'new@example.invalid',job_role_id:job.id,active:true,notes:'Test'});assert.equal(r.status,201);const minimal=r.collaborator;
assert.equal(r.access.status,'invited');assert.equal(r.access.emailSent,false);assert.equal(Number(minimal.compensation_amount),0);assert.equal(minimal.currency,'PYG');assert.ok(minimal.user_id);
assert.equal((await sql('select role from organization_members where user_id=$1 and organization_id=$2',[minimal.user_id,org])).rows[0].role,'viewer');
r=await call(`/api/agency/collaborators/${minimal.id}`,'PATCH',{compensation_amount:1250.50,currency:'USD'});assert.equal(r.status,200);assert.equal(r.access.status,'linked');assert.equal(r.collaborator.full_name,'Minimal profile');assert.equal(Number(r.collaborator.compensation_amount),1250.50);
assert.equal((await sql('select role from organization_members where user_id=$1 and organization_id=$2',[uid,org])).rows[0].role,'owner');
r=await call('/api/agency/collaborators','POST',{full_name:'Finance profile',email:'finance-new@example.invalid'},{...user,role:'finance'});assert.equal(r.status,201);assert.equal(r.collaborator.user_id,null);assert.equal(r.access.status,'needs_admin');
r=await call('/api/agency/collaborators','POST',{full_name:'Inactive profile',email:'inactive@example.invalid',active:false});assert.equal(r.status,201);assert.equal(r.collaborator.user_id,null);
assert.equal((await call('/api/agency/collaborators','POST',{full_name:'Wrong tenant job',job_role_id:job.id},{...user,organization_id:other})).status,400);
assert.equal((await call('/api/agency/job-roles','POST',{name:'Bad'},{...user,role:'finance'})).status,403);
r=await call(`/api/agency/job-roles/${job.id}`,'PATCH',{name:'Renamed role',active:false});assert.equal(r.status,200);
assert.equal((await sql('select job_title from agency_collaborators where id=$1',[minimal.id])).rows[0].job_title,'Renamed role');
assert.equal((await call('/api/agency/collaborators','POST',{full_name:'Archived job',job_role_id:job.id})).status,400);
assert.equal((await call(`/api/agency/job-roles/${job.id}`,'PATCH',{name:'Cross tenant'},{...user,organization_id:other})).status,404);
await sql('select ensure_agency_job_catalog($1)',[org]);assert.equal((await sql('select count(*)::int as n from agency_job_roles where organization_id=$1 and name=$2',[org,job.name])).rows[0].n,0);
const image=await sharp({create:{width:20,height:20,channels:3,background:{r:0,g:100,b:140}}}).png().toBuffer();
r=await call(`/api/agency/collaborators/${minimal.id}`,'PATCH',{photo_url:'data:image/png;base64,'+image.toString('base64')});assert.equal(r.status,200);const savedPhoto=r.collaborator.photo_url;assert.ok(savedPhoto.startsWith('data:image/webp;base64,'));
r=await call(`/api/agency/collaborators/${minimal.id}`,'PATCH',{notes:'Photo remains'});assert.equal(r.collaborator.photo_url,savedPhoto);
assert.equal((await call(`/api/agency/collaborators/${minimal.id}`,'PATCH',{photo_url:''},{...user,organization_id:other})).status,404);
assert.equal((await call(`/api/agency/collaborators/${minimal.id}`,'PATCH',{photo_url:''},{...user,role:'viewer'})).status,403);
assert.equal((await call(`/api/agency/collaborators/${minimal.id}`,'PATCH',{photo_url:'data:application/pdf;base64,YQ=='})).status,400);
r=await call(`/api/agency/collaborators/${minimal.id}`,'PATCH',{photo_url:''});assert.equal(r.status,200);assert.equal(r.collaborator.photo_url,null);
// One directory joins access and people, without changing financial history or permissions.
const beforeTeam=(await sql('select balance from bank_accounts where id=$1',[account])).rows[0].balance;
const team=await call('/api/agency/team');assert.equal(team.status,200);assert.ok(team.collaborators.some(p=>String(p.id)===String(minimal.id)));assert.ok(team.members.some(m=>String(m.id)===String(minimal.user_id)));
assert.ok(team.members.every(m=>!Object.hasOwn(m,'password_hash')));
assert.equal((await call('/api/agency/team','GET',{}, {...user,role:'editor'})).status,200,'every member reaches the directory');
const viewerTeam=await call('/api/agency/team','GET',{}, {...user,role:'viewer'});
assert.equal(viewerTeam.status,200);
assert.ok(Array.isArray(viewerTeam.directory),'non-finance roles receive the stripped directory');
assert.equal(viewerTeam.collaborators,undefined,'directory roles never receive the full record');
assert.ok(viewerTeam.directory.every(m=>!Object.hasOwn(m,'email')&&!Object.hasOwn(m,'compensation_amount')&&!Object.hasOwn(m,'monthly_salary_amount')),'directory rows carry photo, name and cargo only');
assert.equal((await call('/api/agency/team','GET',{}, {...user,role:'finance'})).status,200);
// Salary fields stay behind salary.view: management keeps the team without amounts,
// and nobody outside owner/admin/finance may read or write them.
assert.equal((await call(`/api/agency/collaborators/${minimal.id}`,'PATCH',{payment_day:5,invoices_company:true})).status,200,'owner sets the salary flags');
const managementTeam=await call('/api/agency/team','GET',{}, {...user,role:'management'});
assert.equal(managementTeam.status,200);
assert.ok(managementTeam.collaborators.some(p=>String(p.id)===String(minimal.id)),'management keeps the full team payload');
const managedRow=managementTeam.collaborators.find(p=>String(p.id)===String(minimal.id));
for(const field of ['compensation_amount','monthly_salary_amount','monthly_salary_currency','payment_day','invoices_company'])assert.equal(managedRow[field],null,`${field} stays hidden without salary.view`);
const financeTeam=await call('/api/agency/team','GET',{}, {...user,role:'finance'});
const financeRow=financeTeam.collaborators.find(p=>String(p.id)===String(minimal.id));
assert.ok(Number(financeRow.compensation_amount)>0,'finance keeps the agreed amount');
assert.notEqual(financeRow.payment_day,null,'finance keeps the payment day');
for(const payload of [{payment_day:9},{invoices_company:true},{compensation_amount:250},{monthly_salary_amount:300}]){
 assert.equal((await call(`/api/agency/collaborators/${minimal.id}`,'PATCH',payload,{...user,role:'management'})).status,403,`management cannot write ${Object.keys(payload)[0]}`);
}
assert.equal((await call(`/api/agency/collaborators/${minimal.id}`,'PATCH',{notes:'Management edit'},{...user,role:'management'})).status,200,'management keeps administrative edits');
assert.equal((await call(`/api/agency/collaborators/${minimal.id}`,'PATCH',{job_title:'Editor audiovisual'},{...user,role:'management'})).status,200);
assert.equal((await call('/api/agency/collaborators','POST',{full_name:'Viewer write',email:'viewer@example.invalid'},{...user,role:'viewer'})).status,403);
assert.equal((await call(`/api/agency/collaborators/${minimal.id}`,'PATCH',{notes:'Viewer write'},{...user,role:'viewer'})).status,403);
assert.equal((await call('/api/agency/job-roles','POST',{name:'Cargo viewer'},{...user,role:'viewer'})).status,403);
assert.equal((await call('/api/agency/team','GET',{}, {...user,organization_id:other})).collaborators.length,0);
assert.equal((await call('/api/agency/team','POST')).status,405);
assert.equal((await call('/api/agency/collaborators','POST',{full_name:'Duplicate',email:'NEW@example.invalid'})).status,409);
await sql("insert into agency_archived_records(organization_id,kind,record_id) values($1,'collaborators',$2)",[org,minimal.id]);
const archived=await call('/api/agency/team');assert.ok(!archived.collaborators.some(p=>String(p.id)===String(minimal.id)));assert.ok(archived.archivedProfiles.some(p=>String(p.id)===String(minimal.id)));
assert.equal((await call('/api/agency/collaborators','POST',{full_name:'Duplicate archived',email:'new@example.invalid'})).status,409);
assert.equal((await sql('select balance from bank_accounts where id=$1',[account])).rows[0].balance,beforeTeam);
const commissionWrite={beneficiary_name:'Gate referral',kind:'referral',basis:'collected',percentage:10,amount:0,currency:'PYG',invoice_id:invoice,collaborator_id:pid};
// Issue #14: los helpers de validación se importan de suite-validation.js; no
// vuelven a definirse copias locales con límites o mensajes propios.
const operationsSource=await fs.readFile(new URL('./operations.js',import.meta.url),'utf8');
assert.match(operationsSource,/import \{fail,text,id,optId,option,amount,date,email\} from '\.\/suite-validation\.js';/,'operations.js imports every shared validator');
for(const helper of ['text','id','optId','option','date','email'])assert(!new RegExp(`^(const|function)\\s+${helper}\\b`,'m').test(operationsSource),`operations.js does not redefine ${helper}`);
assert.match(operationsSource,/const money=\(value,zero=false\)=>\{const n=amount\(value\);if\(!zero&&n===0\)fail\('Importe inválido'\);return n;\};/,'the module amount delegates to the shared amount and only adds the zero rule');

// Validación compartida (suite-validation): mismos límites y mensajes que las
// copias que tenía operations.js, incluida la regla del módulo sobre el cero.
const invalidAmount=await call('/api/agency/commissions','POST',{...commissionWrite,basis:'fixed',amount:-1});
assert.equal(invalidAmount.status,400);assert.equal(invalidAmount.error,'Importe inválido');
const invalidDate=await call('/api/agency/payouts','POST',{collaborator_id:pid,account_id:account,amount:10,reference:'QA',paid_on:'2026-13-01'});
assert.equal(invalidDate.status,400);assert.equal(invalidDate.error,'Fecha inválida');
const invalidId=await call('/api/agency/payouts','POST',{collaborator_id:pid,account_id:'abc',amount:10,reference:'QA',paid_on:'2026-09-08'});
assert.equal(invalidId.status,400);assert.equal(invalidId.error,'Identificador inválido');
const invalidOption=await call('/api/agency/commissions','POST',{...commissionWrite,kind:'otro'});
assert.equal(invalidOption.status,400);assert.equal(invalidOption.error,'Opción inválida');
const invalidText=await call('/api/agency/commissions','POST',{...commissionWrite,notes:'x'.repeat(2001)});
assert.equal(invalidText.status,400);assert.equal(invalidText.error,'Texto inválido');
const invalidEmail=await call('/api/agency/collaborators','POST',{full_name:'Correo compartido',email:'no-email'});
assert.equal(invalidEmail.status,400);assert.equal(invalidEmail.error,'Correo inválido','the shared email message replaces the module copy');
const zeroCommission=await call('/api/agency/commissions','POST',{...commissionWrite,basis:'fixed',amount:0});
assert.equal(zeroCommission.status,400);assert.equal(zeroCommission.error,'La comisión debe ser mayor a cero');
const zeroPayout=await call('/api/agency/payouts','POST',{collaborator_id:pid,account_id:account,amount:0,reference:'QA',paid_on:'2026-09-08'});
assert.equal(zeroPayout.status,400);assert.equal(zeroPayout.error,'Importe inválido','a zero payout stays invalid: shared amount plus the module rule');

// Comisiones y referidos: el gate sigue a commissions.manage (el toggle del panel),
// no a finance.view. Un gerente de comisiones sin finance.view opera el módulo y
// finance.view sola no lo abre.
const {rolePermissions}=await import('./permissions.js');
const capabilityUser=async role=>{const rows=(await sql('select capability,allowed from agency_role_permissions where organization_id=$1 and role=$2',[org,role])).rows;return {...user,role,...(rows.length?{capabilities:Object.fromEntries(rows.map(row=>[row.capability,row.allowed]))}:{})};};
async function permissionCall(method,payload){let response;const handled=await rolePermissions({req:{method,socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://test/api/agency/permissions'),db:{query:sql,connect:async()=>({query:sql,release(){}})},session:async()=>user,body:async()=>payload,send:(_,status,data)=>response={status,...data}});assert.equal(handled,true);return response;}
const managerWithout=await capabilityUser('management');
assert.equal((await call('/api/agency/commissions','GET',{},managerWithout)).status,403,'management does not manage commissions by default');
assert.equal((await call('/api/agency/commissions/monthly?month=2026-08','GET',{},managerWithout)).status,403);
assert.equal((await call('/api/agency/commissions','POST',commissionWrite,managerWithout)).status,403);
assert.equal((await call('/api/agency/referral-discounts','GET',{},managerWithout)).status,403);
const financeViewOnly={...user,role:'management',capabilities:{'finance.view':true}};
assert.equal((await call('/api/agency/commissions','GET',{},financeViewOnly)).status,403,'finance.view alone does not open commissions');
assert.equal((await call('/api/agency/commissions/monthly?month=2026-08','GET',{},financeViewOnly)).status,403,'finance.view alone does not open the monthly settlement');
assert.equal((await call('/api/agency/referral-discounts','GET',{},financeViewOnly)).status,403,'finance.view alone does not open referrals');
assert.equal((await call('/api/agency/payouts','GET',{},financeViewOnly)).status,200,'payouts remain behind finance.view by design');
assert.equal((await permissionCall('PATCH',{capability:'commissions.manage',role:'management',allowed:true})).status,200);
const managerWith=await capabilityUser('management');
assert.equal((await call('/api/agency/commissions','GET',{},managerWith)).status,200,'the granted capability opens the commissions list');
assert.equal((await call('/api/agency/commissions/monthly?month=2026-08','GET',{},managerWith)).status,200,'the monthly settlement works without finance.view');
const granted=await call('/api/agency/commissions','POST',commissionWrite,managerWith);assert.equal(granted.status,201);
assert.equal((await call(`/api/agency/commissions/${granted.commission.id}`,'PATCH',{status:'approved'},managerWith)).status,200);
assert.equal((await call('/api/agency/referral-discounts','GET',{},managerWith)).status,200);
assert.equal((await call('/api/agency/payouts','GET',{},managerWith)).status,403,'commissions.manage does not open treasury payouts');
assert.equal((await permissionCall('PATCH',{capability:'commissions.manage',role:'finance',allowed:false})).status,200);
const financeRevoked=await capabilityUser('finance');
assert.equal((await call('/api/agency/commissions','GET',{},financeRevoked)).status,403,'a revoked override closes commissions for finance');
assert.equal((await call('/api/agency/commissions/monthly?month=2026-08','GET',{},financeRevoked)).status,403);
assert.equal((await call('/api/agency/referral-discounts','GET',{},financeRevoked)).status,403);
assert.equal((await call('/api/agency/payouts','GET',{},financeRevoked)).status,200,'finance keeps its treasury endpoints after the revocation');
const panelGranted=await permissionCall('GET');
const panelRow=panelGranted.capabilities.find(capability=>capability.id==='commissions.manage');
assert.deepEqual(panelRow.defaults,['owner','admin','finance'],'the panel exposes commissions.manage with its default roles');
assert.equal(panelRow.overrides.management,true,'the panel reflects the granted override');
assert.equal(panelRow.overrides.finance,false,'and the revoked one');
assert.equal((await permissionCall('PATCH',{capability:'commissions.manage',role:'finance',allowed:null})).status,200);
assert.equal((await call('/api/agency/commissions','GET',{},await capabilityUser('finance'))).status,200,'removing the override restores the finance default');
assert.equal((await permissionCall('PATCH',{capability:'commissions.manage',role:'management',allowed:null})).status,200);
assert.equal((await call('/api/agency/commissions','GET',{},await capabilityUser('management'))).status,403,'and management returns to its default without the capability');
assert.equal((await permissionCall('GET')).capabilities.find(capability=>capability.id==='commissions.manage').overrides.management,undefined,'the panel clears the override');
await pg.close();console.log('PASS: collaborators, comments, commissions, payouts, tenant isolation, profile photos, unified directory, permission boundaries, archived profiles, duplicate prevention and audit');
