import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {PGlite} from '@electric-sql/pglite';
import {budgetSections} from './budget-sections.js';
import {visibleRecord} from './record-lifecycle.js';
import {ensurePersonalIdentity} from './identity-session.js';
import {suite} from './agency-suite.js';
import {currencies} from './currencies.js';

// Execute the actual POST route bodies, session and audit helpers from server.js.
// Never import server.js: that would open a port, initialize a configured database
// and start scheduled jobs. Only this in-memory database is available to the test.
const source=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
function between(start,end){
 const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
 assert(a>=0&&b>a,`Server test anchor missing: ${start}`);
 assert.equal(source.indexOf(start,a+start.length),-1,`Ambiguous anchor: ${start}`);
 return source.slice(a,b);
}
const routes=[
 between("    if (url.pathname === '/api/agency/budgets' && req.method === 'POST') {","    if (url.pathname === '/api/agency/accounts' && req.method === 'GET') {"),
 between("    if (url.pathname === '/api/agency/accounts' && req.method === 'POST') {","    if (url.pathname === '/api/agency/custodians' && req.method === 'GET') {"),
 between("    if (url.pathname === '/api/agency/invoices' && req.method === 'POST') {","    if (url.pathname === '/api/agency/payments' && req.method === 'GET') {")
].join('\n');
const helpers=between('const send =','const cookie =')+between('const parseCookies =','const id =')+between('async function session(req) {','function security(');
const pg=new PGlite();
try{
 await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
 for(const name of ['20260908_treasury_ledger.sql','20260908_google_oauth.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql','20260910_productivity.sql','20260910_profile_identity.sql','20260910_demo_sessions.sql','20260910_invite_links.sql','20260910_currencies.sql','20260910_company_currency.sql','20260910_global_identity.sql'])await pg.exec(await fs.readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8'));
 const query=(sql,args)=>pg.query(sql,args),db={query,connect:async()=>({query,release(){}})};
 const {post,session}=new Function('db','budgetSections','crypto','visibleRecord','ensurePersonalIdentity','demoOrganization','currencies',`${helpers}
  return {session,post:async function(req,res){const url=new URL(req.url,'https://test.invalid');${routes}
   throw new Error('Unexpected route in isolated POST test');}};`)(db,budgetSections,crypto,visibleRecord,ensurePersonalIdentity,()=>{throw new Error('Demo setup is outside this test');},currencies);
 const userId=(await query("insert into users(email,password_hash) values('currency-post@example.invalid','unused') returning id")).rows[0].id;
 const companies=[];
 for(const label of ['one','two','unconfigured']){
  const org=(await query('insert into organizations(slug,name) values($1,$2) returning id',[`currency-post-${label}`,`Currency fixture ${label}`])).rows[0].id;
  await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,userId]);
  const token=`fixture-currency-${label}`;
  await query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '1 hour')",[token,userId,org]);
  const client=(await query("insert into agency_clients(organization_id,name) values($1,'Fixture client') returning id",[org])).rows[0].id;
  companies.push({org,client,token});
 }
 function request(kind,payload,company){
  const req=Readable.from([JSON.stringify(payload)]);req.method='POST';req.url=`/api/agency/${kind}`;req.headers={cookie:company?`scale_session=${company.token}`:''};req.socket={remoteAddress:'127.0.0.1'};return req;
 }
 async function configure(company,currency){
  let result;
  const req=request('settings',{default_currency:currency},company);req.method='PATCH';
  await suite({req,res:{},url:new URL('https://test.invalid/api/agency/settings'),db,session,body:async()=>({default_currency:currency}),send:(_,status,data)=>{result={status,...data};}});
  assert.equal(result.status,200);assert.equal(result.default_currency,currency);
 }
 let accountSequence=0;
 const definitions=[
  {kind:'budgets',key:'budget',table:'agency_budgets',payload:client=>({title:'Fixture quote',clientId:client,items:[{description:'Fixture service',quantity:1,unitPrice:10}]})},
  {kind:'accounts',key:'account',table:'bank_accounts',payload:()=>({name:`Fixture account ${++accountSequence}`})},
  {kind:'invoices',key:'invoice',table:'agency_invoices',payload:client=>({clientId:client,total:10})}
 ];
 const retained=[];let cases=0;
 async function call(def,company,extra={}){
  let status,data;
  await post(request(def.kind,{...def.payload(company?.client||companies[0].client),...extra},company),{writeHead(value){status=value;},end(value){data=JSON.parse(value);}});
  cases++;return {status,...data};
 }
 async function expectCreated(def,company,extra,currency){
  const response=await call(def,company,extra);assert.equal(response.status,201,`${def.kind}: ${JSON.stringify(response)}`);
  const row=response[def.key];assert.equal(row.currency,currency);assert.equal(String(row.organization_id),String(company.org));
  retained.push({table:def.table,id:row.id,currency});return row;
 }
 const [one,two,unconfigured]=companies;
 await configure(two,'BRL');
 for(const [index,currency] of currencies.entries()){
  await configure(one,currency);
  for(const def of definitions){
   await expectCreated(def,one,{},currency);
   await expectCreated(def,one,{currency:currencies[(index+1)%currencies.length]},currencies[(index+1)%currencies.length]);
  }
 }
 // Company changes after opening a form must not replace the currency it sends.
 const chosenBeforeChange='EUR';await configure(one,'MXN');
 for(const def of definitions){
  await expectCreated(def,one,{currency:chosenBeforeChange},chosenBeforeChange);
  await expectCreated(def,one,{},'MXN');
  await expectCreated(def,two,{},'BRL');
  await expectCreated(def,unconfigured,{},'PYG');
  await expectCreated(def,one,{organization_id:two.org,default_currency:'BRL'},'MXN');
  for(const invalid of ['GBP','',null]){
   const before=(await query(`select count(*)::int as n from ${def.table}`)).rows[0].n;
   assert.equal((await call(def,one,{currency:invalid})).status,400,'explicit invalid currency is not replaced by the default');
   assert.equal((await query(`select count(*)::int as n from ${def.table}`)).rows[0].n,before);
  }
  assert.equal((await call(def,null)).status,403);
 }
 for(const def of definitions.filter(d=>d.kind!=='accounts'))assert.equal((await call(def,one,{clientId:two.client})).status,404);
 await query("update organization_members set role='viewer' where organization_id=$1 and user_id=$2",[one.org,userId]);
 for(const def of definitions)assert.equal((await call(def,one)).status,403);
 // Changing configuration did not rewrite any records already created.
 for(const row of retained)assert.equal((await query(`select currency from ${row.table} where id=$1`,[row.id])).rows[0].currency,row.currency);
 console.log(`PASS: ${cases} actual POST route cases; six company currencies, explicit choices preserved after settings change, tenant settings, unconfigured PYG fallback, invalid currencies rejected, permissions, tenant isolation and existing rows unchanged. PGlite only; no server/init/network started.`);
}finally{await pg.close();}
