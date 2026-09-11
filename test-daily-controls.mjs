import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {financeControls} from './finance-controls.js';
import {contentReview} from './content-review.js';
import {suite} from './agency-suite.js';
import {budgetDocument} from './budget-document.js';
import {budgetSections} from './budget-sections.js';
const pg=new PGlite();await pg.exec(await fs.readFile('schema.sql','utf8'));
for(const name of ['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql'])await pg.exec(await fs.readFile('migrations/'+name,'utf8'));
// The current work-order PATCH writes drive_links, as in the production migration chain.
await pg.exec(await fs.readFile('migrations/20260911_drive_links.sql','utf8'));
const query=(q,p)=>pg.query(q,p),db={query,connect:async()=>({query,release(){}})};
const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
const uid=(await query("insert into users(email,password_hash) values('daily@example.invalid','none') returning id")).rows[0].id;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,uid]);
const other=(await query("insert into organizations(slug,name) values('daily-other','Other') returning id")).rows[0].id;
const user={id:uid,organization_id:org,role:'owner'};
async function call(path,method='GET',payload={},as=user,form=''){
 let result={};const args={req:{method,headers:{},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){yield form;}},res:{writeHead(status,headers){result={status,headers};},end(content){result.content=content;}},url:new URL('https://test'+path),db,session:async()=>as,body:async()=>payload,send:(_,status,data)=>{result={status,...data};}};
 assert.ok(await financeControls(args)||await contentReview(args)||await suite(args));return result;
}
const client=(await query("insert into agency_clients(organization_id,name) values($1,'Daily QA') returning id",[org])).rows[0].id;
const invoice=(await query("insert into agency_invoices(organization_id,client_id,number,total) values($1,$2,'DAILY-QA',1000000) returning id",[org,client])).rows[0].id;
const account=async(name,currency)=> (await query("insert into bank_accounts(organization_id,name,currency,account_type) values($1,$2,$3,'bank') returning id",[org,name,currency])).rows[0].id;
const cash=await account('Cash','PYG'),usd=await account('USD','USD');
const receiptPayload={invoiceId:invoice,accountId:cash,amount:750000,reference:'R-1',receivedOn:'2026-09-08',requestId:'11111111-1111-4111-a111-111111111111'};
let r=await call('/api/agency/payments','POST',receiptPayload);assert.equal(r.status,201);const receipt=r.payment.id;
assert.equal((await call('/api/agency/payments','POST',receiptPayload)).payment.id,receipt);
assert.equal((await call('/api/agency/payments','POST',{...receiptPayload,amount:1})).status,409);
assert.equal((await call('/api/agency/payments','POST',{invoiceId:invoice,accountId:cash,amount:300000})).status,400);
assert.equal((await call('/api/agency/payments','GET',{}, {...user,role:'sales'})).status,403);
assert.equal((await call('/api/agency/payments','GET',{},null)).status,401);
const transferPayload={fromAccountId:cash,toAccountId:usd,amount:750000,receivedAmount:100,reference:'FX-1',transferredOn:'2026-09-08',requestId:'22222222-2222-4222-a222-222222222222'};
r=await call('/api/agency/transfers','POST',transferPayload);assert.equal(r.status,201);
assert.equal((await call('/api/agency/transfers','POST',transferPayload)).transfer.id,r.transfer.id);
assert.equal((await query('select balance from bank_accounts where id=$1',[usd])).rows[0].balance,'100.00');
assert.equal((await call(`/api/agency/payments/${receipt}/reverse`,'POST',{reason:'Prueba de reversión'})).status,409);
assert.equal((await call('/api/agency/transfers','POST',{fromAccountId:usd,toAccountId:cash,amount:101,receivedAmount:757500})).status,409);
assert.equal((await call(`/api/agency/payments/${receipt}/reverse`,'POST',{reason:'Otra empresa'}, {...user,organization_id:other})).status,404);
assert.equal((await call('/api/agency/transfers','POST',{fromAccountId:usd,toAccountId:cash,amount:100,receivedAmount:750000,reference:'FX-RETURN',transferredOn:'2026-09-08'})).status,201);
r=await call(`/api/agency/payments/${receipt}/reverse`,'POST',{reason:'Corrección de prueba',reversed_on:'2026-09-08'});assert.equal(r.status,201);const reversal=r.reversal.id;
assert.equal((await call(`/api/agency/payments/${receipt}/reverse`,'POST',{reason:'Mismo reintento'})).reversal.id,reversal);
assert.equal((await query('select balance from bank_accounts where id=$1',[cash])).rows[0].balance,'0.00');
assert.equal((await query('select paid_amount from agency_invoices where id=$1',[invoice])).rows[0].paid_amount,'0.00');
assert.equal((await query('select amount from agency_payments where id=$1',[receipt])).rows[0].amount,'750000.00');
assert.equal((await call('/api/agency/payments','POST',{invoiceId:invoice,accountId:cash,amount:1000000,reference:'R-2',receivedOn:'2026-09-08'})).status,201);
assert.equal((await query('select status from agency_invoices where id=$1',[invoice])).rows[0].status,'paid');
const lines=[{external_id:'bank-1',booked_on:'2026-09-08',amount:750000,reference:'R-1'},{external_id:'bank-2',booked_on:'2026-09-08',amount:-750000,reference:'FX-1'},{external_id:'bank-3',booked_on:'2026-09-08',amount:1000000,reference:'R-2'}];
assert.equal((await call('/api/agency/reconciliation','POST',{accountId:cash,lines})).imported,3);
assert.equal((await call('/api/agency/reconciliation','POST',{accountId:cash,lines})).imported,0);
assert.equal((await call('/api/agency/reconciliation','POST',{accountId:cash,lines:[{...lines[0],amount:1}]})).status,409);
assert.equal((await call(`/api/agency/reconciliation/${cash}/auto`,'POST')).matched,3);
assert.equal((await call(`/api/agency/reconciliation/${cash}/auto`,'POST')).matched,0);
const rec=await call(`/api/agency/reconciliation?accountId=${cash}`);assert.equal(rec.lines.filter(l=>l.match_id).length,3);
assert.equal((await call(`/api/agency/reconciliation/${rec.lines[0].id}/unmatch`,'POST')).status,200);
assert.equal((await call('/api/agency/reconciliation','POST',{accountId:cash,lines:[{...lines[2],external_id:'bank-duplicate-reference'}]})).imported,1);
assert.equal((await call(`/api/agency/reconciliation/${cash}/auto`,'POST')).matched,0,'Ambiguous references must remain pending');
assert.equal((await call(`/api/agency/reconciliation?accountId=${cash}`,'GET',{}, {...user,organization_id:other})).status,404);
assert.equal((await query('select balance from bank_accounts where id=$1',[cash])).rows[0].balance,'1000000.00');
const project=(await query("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Project') returning id",[org,client])).rows[0].id;
const order=(await query("insert into agency_work_orders(organization_id,project_id,title,status,drive_url,approval_step) values($1,$2,'QA piece','approved','https://drive.google.com/example',1) returning id",[org,project])).rows[0].id;
// Both PATCH routes must distinguish omitted links from an explicit replacement/clear.
for(const [kind,key,table,rename] of [
 ['projects',project,'agency_projects',{name:'Project links QA'}],
 ['work-orders',order,'agency_work_orders',{title:'Piece links QA'}],
]){
 const path=`/api/agency/${kind}/${key}`;
 const stored=async()=> (await query(`select drive_url,drive_links from ${table} where id=$1`,[key])).rows[0];
 const patch=async payload=>{const result=await call(path,'PATCH',payload);assert.equal(result.status,200,`${kind}: PATCH must succeed`);return stored();};
 const original='https://drive.google.com/example',replacement='https://drive.google.com/new-version';
 // Historical records have only drive_url, even after the migration defaults drive_links to [].
 await query(`update ${table} set drive_url=$1,drive_links='[]'::jsonb where id=$2`,[original,key]);
 assert.equal((await patch(rename)).drive_url,original,`${kind}: unrelated edits preserve a legacy asset`);
 const multiple=[{url:original,label:'Principal'},{url:'https://drive.google.com/secondary',label:'Material adicional'}];
 assert.deepEqual(await patch({drive_links:multiple}),{drive_url:original,drive_links:multiple});
 assert.deepEqual(await patch(rename),{drive_url:original,drive_links:multiple},`${kind}: omitted links preserve order and labels`);
 const changed=[{...multiple[0],url:replacement},multiple[1]];
 assert.deepEqual(await patch({drive_url:replacement}),{drive_url:replacement,drive_links:changed},`${kind}: legacy primary edits retain additional links`);
 const explicit=[{url:'https://drive.google.com/replacement',label:'Nueva lista'}];
 assert.deepEqual(await patch({drive_url:original,drive_links:explicit}),{drive_url:explicit[0].url,drive_links:explicit},`${kind}: explicit list takes precedence`);
 for(const payload of [{drive_links:[]},{drive_links:''},{drive_links:null},{drive_url:''},{drive_url:null}]){
  await patch({drive_links:multiple});
  assert.deepEqual(await patch(payload),{drive_url:null,drive_links:[]},`${kind}: explicit empty clears assets`);
  assert.deepEqual(await patch(rename),{drive_url:null,drive_links:[]},`${kind}: omitted links do not resurrect cleared assets`);
 }
 assert.deepEqual(await patch({drive_url:replacement}),{drive_url:replacement,drive_links:[{url:replacement,label:'Archivo o carpeta'}]},`${kind}: legacy URL creates an asset from an empty list`);
 await patch({drive_links:multiple});
 assert.deepEqual(await patch({drive_url:original,drive_links:[]}),{drive_url:null,drive_links:[]},`${kind}: an explicit empty list overrides a stale primary`);
 await patch({drive_links:multiple});
 for(const payload of [{drive_url:'javascript:alert(1)'},{drive_links:[{url:'http://example.com/unsafe'}]}]){
  assert.equal((await call(path,'PATCH',payload)).status,400);
  assert.deepEqual(await stored(),{drive_url:original,drive_links:multiple},`${kind}: rejected URLs leave stored assets intact`);
 }
 assert.equal((await call(path,'PATCH',{drive_links:[]},{...user,organization_id:other})).status,404);
 assert.equal((await call(path,'PATCH',{drive_links:[]},{...user,role:'viewer'})).status,403);
 assert.deepEqual(await stored(),{drive_url:original,drive_links:multiple},`${kind}: unauthorized edits leave assets intact`);
}
r=await call(`/api/agency/work-orders/${order}/client-review`,'POST');assert.equal(r.status,200);let token=r.url.split('/').at(-1);
assert.equal((await call(`/api/agency/work-orders/${order}/publish`,'POST')).status,400);
assert.equal((await call(`/review/${token}`)).status,200);
r=await call(`/api/agency/work-orders/${order}`,'PATCH',{drive_url:'https://drive.google.com/new-version'});
assert.equal(r.status,200,'Updating the piece must succeed before checking stale review rejection');
assert.equal((await query('select drive_url from agency_work_orders where id=$1',[order])).rows[0].drive_url,'https://drive.google.com/new-version','The requested asset must be persisted; do not accept a review invalidated only by an unrelated timestamp change');
assert.equal((await call(`/review/${token}/respond`,'POST',{},null,'name=QA&action=approve')).status,409);
r=await call(`/api/agency/work-orders/${order}/client-review`,'POST');
assert.equal((await call(`/review/${token}`)).status,404,'Previous pending link is revoked');token=r.url.split('/').at(-1);
assert.equal((await call(`/review/${token}/respond`,'POST',{},null,'name=QA&action=changes&feedback=Corregir+el+logo')).status,303);
assert.equal((await query('select status from agency_work_orders where id=$1',[order])).rows[0].status,'editing');
assert.equal((await call(`/review/${token}/respond`,'POST',{},null,'name=QA&action=approve')).status,409);
await query("update agency_work_orders set status='approved',approval_step=1 where id=$1",[order]);
r=await call(`/api/agency/work-orders/${order}/client-review`,'POST');token=r.url.split('/').at(-1);
assert.equal((await call(`/review/${token}/respond`,'POST',{},null,'name=QA&action=approve')).status,303);
assert.equal((await call(`/api/agency/work-orders/${order}/publish`,'POST')).status,200);
assert.equal((await call(`/api/agency/work-orders/${order}/client-review`,'POST',{}, {...user,role:'editor'})).status,403);
assert.equal((await call('/review/'+'0'.repeat(64))).status,404);
const doc={number:'QA',title:'Custom',organization_name:'Scale',client_name:'Demo',currency:'USD',subtotal:100,total:110,tax_rate:.1,notes:'Hidden notes',sections:[{type:'text',title:'Alcance',body:'<script>unsafe</script>',enabled:true},{type:'items',enabled:true},{type:'totals',enabled:true},{type:'notes',enabled:false}]};
const html=budgetDocument(doc,[{description:'One',quantity:1,unit_price:100,total:100}]);assert.ok(html.indexOf('Alcance')<html.indexOf('<table>'));assert.ok(!html.includes('Hidden notes'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
assert.throws(()=>budgetSections([{type:'totals',enabled:false},{type:'items',enabled:true}]));
assert.equal((await query("select count(*)::int as n from agency_operation_audit where table_name='agency_payments' and actor=$1",[String(uid)])).rows[0].n,2);
// Apply migration again: no balance changes, no duplicate data.
await pg.exec(await fs.readFile('migrations/20260908_daily_controls.sql','utf8'));
assert.equal((await query('select balance from bank_accounts where id=$1',[cash])).rows[0].balance,'1000000.00');
await pg.close();console.log('PASS: partial receipts, FX, reversal idempotency, insufficient funds, tenant/role isolation, reconciliation import/dedup/matches, client review and publication gate, PDF sections, actor audit, migration re-run');
