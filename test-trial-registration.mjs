// Run: node --experimental-vm-modules test-trial-registration.mjs
// Real server and local domain modules, ephemeral PostgreSQL and OAuth fixtures.
// No sockets, browser, provider requests, application credentials or shared DB.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

assert(vm.SourceTextModule, 'Use node --experimental-vm-modules');
const pg=new PGlite(),source=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
// Discover the migrations registered by init(), preserving source order instead
// of maintaining a second, inevitably stale migration list in this test.
const init=source.slice(source.indexOf('async function init()'),source.indexOf('async function provisionOwner('));
// The optional Dadoo integration is a separate, unshipped worktree change.
const migrations=Array.from(init.matchAll(/['"](?:migrations\/)?(\d{8}_[\w-]+\.sql)['"]/g),m=>m[1]).filter(file=>file!=='20260908_dadoo_hub.sql');
assert(migrations.includes('20260911_subscriptions.sql'));
assert(migrations.includes('20260911_trial_registration.sql'));
await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
for(const file of migrations)await pg.exec(await fs.readFile(new URL('./migrations/'+file,import.meta.url),'utf8'));

// PGlite has one connection. Model pg Pool(max=1), holding a connection until
// release, so concurrent callbacks cannot interleave unrelated transactions.
// This exercises overlapping requests, NOT PostgreSQL multi-connection locks.
let queue=Promise.resolve(),connections=0,requests=0,googleCalls=0,forbiddenCalls=0,handler;
const databaseErrors=[];
async function connect(){
 const prior=queue;let unlock;queue=new Promise(resolve=>{unlock=resolve;});await prior;
 connections++;let released=false;
 return {async query(s,v){try{return await pg.query(s,v);}catch(e){databaseErrors.push({code:e.code,message:e.message});throw e;}},release(){assert(!released);released=true;connections--;unlock();}};
}
async function query(s,v){const c=await connect();try{return await c.query(s,v);}finally{c.release();}}
const rows=async(s,v)=>(await query(s,v)).rows;
const insert=async(s,v)=>(await rows(s+' returning id',v))[0].id;
const profiles=new Map();
async function mockGoogle(url,options={}){
 googleCalls++;
 if(url==='https://oauth2.googleapis.com/token'){
  assert.equal(options.method,'POST');const code=options.body.get('code');assert(profiles.has(code));
  return {ok:true,json:async()=>({access_token:code})};
 }
 if(url==='https://openidconnect.googleapis.com/v1/userinfo'){
  const code=options.headers.Authorization.replace(/^Bearer /,'');assert(profiles.has(code));
  return {ok:true,json:async()=>profiles.get(code)};
 }
 forbiddenCalls++;throw Error('Forbidden non-Google fetch in isolated regression');
}
const context=vm.createContext({console,URL,URLSearchParams,Buffer,AbortSignal,TextEncoder,TextDecoder,
 fetch:mockGoogle,process:{env:{GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',STRIPE_BILLING_ENABLED:'false'}},
 setTimeout,clearTimeout,setInterval(){throw Error('Background jobs are not allowed');},clearInterval});
// Load local modules in the SAME isolated context: billing/email modules cannot
// inherit the developer shell's provider keys or global fetch accidentally.
const modules=new Map();
async function load(spec,ref){
 const key=spec.startsWith('.')?new URL(spec,ref.identifier).href:spec;
 if(modules.has(key))return modules.get(key);
 let mod;
 if(key.startsWith('file:')){
  mod=new vm.SourceTextModule(await fs.readFile(new URL(key),'utf8'),{context,identifier:key,initializeImportMeta(meta){meta.url=key;}});
 }else{
  let exports;
  if(key==='node:http')exports={default:{createServer(fn){handler=fn;return {listen(){}};}}};
  else if(key==='pg')exports={default:{Pool:class{query=query;connect=connect;}}};
  else exports=await import(key);
  const keys=Object.keys(exports);mod=new vm.SyntheticModule(keys,function(){for(const k of keys)this.setExport(k,exports[k]);},{context,identifier:key});
 }
 modules.set(key,mod);return mod;
}
const main=await load('./server.js',{identifier:import.meta.url});await main.link(load);await main.evaluate();
assert.equal(typeof handler,'function');
async function request(path,{cookie='',method='GET',payload}={}){
 requests++;const result={status:0,headers:{},body:''};
 await handler({url:path,method,headers:{host:'admin.scaleparaguay.com',cookie,'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'},
  async *[Symbol.asyncIterator](){if(payload!==undefined)yield JSON.stringify(payload);}},
 {setHeader(k,v){result.headers[k]=v;},writeHead(s,h){result.status=s;Object.assign(result.headers,h);},end(value){result.body=value||'';}});
 assert.equal(result.headers['Cache-Control'],'no-store');return {...result,data:JSON.parse(result.body||'{}')};
}
const cookieOf=r=>{assert.equal(typeof r.headers['Set-Cookie'],'string');return r.headers['Set-Cookie'].split(';')[0];};
const me=async cookie=>{const r=await request('/api/auth/me',{cookie});assert.equal(r.status,200);return r.data.user;};
const count=async table=>Number((await rows(`select count(*) as n from ${table}`))[0].n);
async function start(currency='USD',extra={}){
 const params=new URLSearchParams({signup:'1',company:'Fixture private agency',currency,consent:'1',...extra});
 const r=await request('/api/auth/google/start?'+params);assert.equal(r.status,302,JSON.stringify(r.data));
 const url=new URL(r.headers.Location);assert.equal(url.origin,'https://accounts.google.com');
 return {state:url.searchParams.get('state'),cookie:cookieOf(r)};
}
async function callback(flow,profile){
 const code=crypto.randomUUID();profiles.set(code,profile);
 return request('/api/auth/google/callback?'+new URLSearchParams({state:flow.state,code}),{cookie:flow.cookie});
}
async function complete(r,trial=true){
 assert.equal(r.status,302);assert(r.headers.Location.includes('/api/auth/google/complete?ticket='),r.headers.Location+' '+JSON.stringify(databaseErrors));
 const url=new URL(r.headers.Location),path=url.pathname.replace(/^\/core-api/,'')+url.search;
 const hash=crypto.createHash('sha256').update(url.searchParams.get('ticket')).digest('hex');
 assert.equal((await rows('select trial_registration from oauth_handoffs where token_hash=$1',[hash]))[0].trial_registration,trial);
 const response=await request(path);assert.equal(response.status,302);
 assert.equal(response.headers.Location,trial?'https://app.scaleparaguay.com/produccion':'https://app.scaleparaguay.com/?chooseCompany=1');
 return {cookie:cookieOf(response),path};
}
async function signup(profile,currency='USD'){return complete(await callback(await start(currency),profile));}
async function fixtureCookie(user,org){
 const token=crypto.randomUUID();await query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '1 day')",[token,user,org]);
 return 'scale_session='+token;
}
async function assertTrial(org,currency){
 const [sub]=await rows('select * from organization_subscriptions where organization_id=$1',[org]);assert(sub);
 assert.equal(sub.currency,currency);assert.equal(+sub.trial_ends_at- +sub.trial_started_at,30*86400000);
 assert.equal(+sub.due_at,+sub.trial_ends_at);assert.equal(sub.paid_through_at,null);assert.equal(sub.stripe_customer_id,null);
 return sub;
}
async function emptyOperations(org){
 // Names are from the live schema, not input. Check ALL organization-owned
 // business tables, including future modules, with only onboarding exceptions.
 const tables=await rows("select table_name from information_schema.columns where table_schema='public' and column_name='organization_id' and table_name in(select tablename from pg_tables where schemaname='public') order by table_name");
 // Database audit rows for onboarding are expected; they are not copied work.
 const allowed=new Set(['organization_members','agency_settings','agency_user_profiles','os_trial_registrations','organization_subscriptions','sessions','oauth_handoffs','agency_operation_audit','agency_reporting_coverage']);
 const coverage=await rows('select c.history_since,o.created_at from agency_reporting_coverage c join organizations o on o.id=c.organization_id where c.organization_id=$1',[org]);
 assert.equal(coverage.length,1,'new agency starts one reporting coverage marker');
 assert(+coverage[0].history_since>= +coverage[0].created_at,'onboarding cannot invent prior reporting coverage');
 for(const {table_name:table} of tables){
  assert(/^[a-z_]+$/.test(table));if(allowed.has(table))continue;
  assert.equal(Number((await rows(`select count(*) as n from "${table}" where organization_id=$1`,[org]))[0].n),0,`new trial copied/created data in ${table}`);
 }
 for(const audit of await rows('select table_name from agency_operation_audit where organization_id=$1',[org]))assert(['agency_user_profiles','agency_settings','organization_members'].includes(audit.table_name),'only onboarding may produce new-company audit rows');
}

try{
 const existing=await insert("insert into organizations(slug,name) values('trial-existing','Existing fixture')");
 const priorUser=await insert("insert into users(email,password_hash) values('prior-trial@example.invalid','unchanged-password-fixture')");
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')",[existing,priorUser]);
 const priorCookie=await fixtureCookie(priorUser,existing);
 assert.equal((await request('/api/agency/productivity/profile',{cookie:priorCookie,method:'PATCH',payload:{full_name:'Prior Personal Identity',photo_url:'https://example.invalid/prior.png'}})).status,200);
 const priorIdentity=await rows('select * from user_personal_identities where user_id=$1',[priorUser]);
 const priorMembership=await rows('select * from organization_members where user_id=$1',[priorUser]);
 const priorUserRow=await rows('select * from users where id=$1',[priorUser]);
 const sourceDemo=await insert("insert into organizations(slug,name,demo_owner_user_id,demo_expires_at) values('trial-source-demo','Synthetic source demo',$1,now()+interval '1 day')",[priorUser]);
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[sourceDemo,priorUser]);
 for(const org of [existing,sourceDemo])await query("insert into agency_clients(organization_id,name) values($1,'DO NOT COPY FIXTURE')",[org]);
 const sourceClients=await rows('select * from agency_clients order by id');
 const existingOrganizations=await rows('select * from organizations order by id');
 const baselineOrgs=await count('organizations');

 // Reject invalid details before issuing an OAuth state, without enrollment.
 const initialStates=await count('oauth_states');
 for(const extra of [{consent:''},{consent:'0'},{currency:'EUR'},{currency:'usd'},{company:'x'},{invite:'not-a-real-invite'}]){
  const r=await request('/api/auth/google/start?'+new URLSearchParams({signup:'1',company:'Fixture',currency:'USD',consent:'1',...extra}));
  assert.equal(r.status,400);assert.equal(r.headers['Set-Cookie'],undefined);
 }
 assert.equal(await count('oauth_states'),initialStates);
 for(const verified of [false,'true',undefined]){
  const r=await callback(await start(),{email:'unverified-trial@example.invalid',email_verified:verified});assert.equal(r.status,403);
 }
 assert.equal(await count('organizations'),baselineOrgs);assert.equal(await count('organization_subscriptions'),0);
 assert.equal((await rows("select id from users where email='unverified-trial@example.invalid'")).length,0);
 console.log('PASS: invalid consent/currency/company/invite and unverified Google identities cannot enroll');

 const usd=await signup({email:'new-trial@example.invalid',name:'New Trial Owner',email_verified:true}),usdUser=await me(usd.cookie);
 const usdOrg=usdUser.organization_id;assert.equal(usdUser.role,'owner');assert.equal(usdUser.subscription.status,'trialing');
 assert.equal(usdUser.subscription.canManage,true);assert.equal(usdUser.subscription.hasAccess,true);assert.equal(usdUser.subscription.checkoutReady,false);
 assert.equal(usdUser.subscription.amount,10);assert.equal(usdUser.default_currency,'USD');await assertTrial(usdOrg,'USD');
 const [orgRow]=await rows('select * from organizations where id=$1',[usdOrg]);assert.equal(orgRow.demo_owner_user_id,null);assert.equal(orgRow.demo_source_id,null);
 const member=await rows('select user_id,role from organization_members where organization_id=$1',[usdOrg]);assert.deepEqual(member,[{user_id:usdUser.id,role:'owner'}]);
 assert.equal((await request('/api/auth/organizations',{cookie:usd.cookie})).data.organizations.length,1);
 await emptyOperations(usdOrg);
 assert.equal((await rows('select consent_version from os_trial_registrations where user_id=$1',[usdUser.id])).length,1);
 assert.equal((await request('/api/auth/switch-organization',{cookie:usd.cookie,method:'POST',payload:{organizationId:existing}})).status,403);
 const callsBeforeReplay=googleCalls;
 assert.equal((await request(usd.path)).headers['Set-Cookie'],undefined,'handoff may be exchanged only once');
 assert.equal(googleCalls,callsBeforeReplay);

 const pyg=await signup({email:'prior-trial@example.invalid',name:'Google must not overwrite identity',email_verified:true},'PYG'),pygUser=await me(pyg.cookie);
 const pygOrg=pygUser.organization_id;assert.notEqual(pygOrg,existing);assert.equal(pygUser.id,priorUser);assert.equal(pygUser.role,'owner');
 assert.equal(pygUser.default_currency,'PYG');assert.equal(pygUser.subscription.amount,50000);await assertTrial(pygOrg,'PYG');await emptyOperations(pygOrg);
 assert.deepEqual(await rows('select user_id,role from organization_members where organization_id=$1',[pygOrg]),[{user_id:priorUser,role:'owner'}]);
 assert.equal(pygUser.full_name,'Prior Personal Identity');assert.equal(pygUser.photo_url,'https://example.invalid/prior.png');
 assert.deepEqual(await rows('select * from user_personal_identities where user_id=$1',[priorUser]),priorIdentity);
 assert.deepEqual(await rows('select * from users where id=$1',[priorUser]),priorUserRow);
 assert.deepEqual(await rows('select * from organization_members where user_id=$1 and organization_id=$2',[priorUser,existing]),priorMembership);
 assert.equal((await me(priorCookie)).role,'viewer');
 assert.deepEqual(await rows('select * from agency_clients order by id'),sourceClients);
 assert.deepEqual(await rows('select * from organizations where id=any($1::bigint[]) order by id',[existingOrganizations.map(o=>o.id)]),existingOrganizations);
 console.log('PASS: USD/PYG private owner-only 30-day trials, empty business tables, prior identity/membership/data unchanged');

 // Concurrent FIRST signups with different valid states must create one org.
 const beforeConcurrent=await count('organizations'),dupeProfile={email:'concurrent-trial@example.invalid',name:'Concurrent Owner',email_verified:true};
 const flows=await Promise.all([start('USD',{company:'First name'}),start('PYG',{company:'Second name'})]);
 const results=await Promise.all(flows.map(flow=>callback(flow,dupeProfile)));
 const logins=await Promise.all(results.map(r=>complete(r))),actors=await Promise.all(logins.map(login=>me(login.cookie)));
 assert.equal(actors[0].organization_id,actors[1].organization_id);assert.equal(await count('organizations'),beforeConcurrent+1);
 const dupeOrg=actors[0].organization_id,dupeSub=(await rows('select * from organization_subscriptions where organization_id=$1',[dupeOrg]))[0];
 assert.equal((await rows('select * from os_trial_registrations where user_id=$1',[actors[0].id])).length,1);
 assert.equal((await rows('select * from organization_members where user_id=$1',[actors[0].id])).length,1);
 const duplicate=await signup(dupeProfile,dupeSub.currency==='USD'?'PYG':'USD');assert.equal((await me(duplicate.cookie)).organization_id,dupeOrg);
 assert.deepEqual((await rows('select * from organization_subscriptions where organization_id=$1',[dupeOrg]))[0],dupeSub);
 assert.equal(await count('organizations'),beforeConcurrent+1);
 const beforeStateReplay=googleCalls;
 for(const flow of flows)assert.equal((await callback(flow,dupeProfile)).status,400);
 assert.equal(googleCalls,beforeStateReplay,'consumed states never reach Google');
 const ordinary=await complete(await callback(await start('USD',{signup:'0'}),dupeProfile),false);
 assert.equal((await me(ordinary.cookie)).organization_id,dupeOrg,'ordinary login keeps company selection instead of signup redirect');
 const oneState=await start(),sessionCount=await count('sessions');
 const sameStateResults=await Promise.all([callback(oneState,dupeProfile),callback(oneState,dupeProfile)]);
 assert.deepEqual(sameStateResults.map(r=>r.status).sort(),[302,400]);
 const handed=await complete(sameStateResults.find(r=>r.status===302));
 assert.equal((await me(handed.cookie)).organization_id,dupeOrg);assert.equal(await count('sessions'),sessionCount+1);
 const forged=await callback({...await start(),cookie:'scale_oauth_state=wrong'},dupeProfile);assert.equal(forged.status,302);assert(forged.headers.Location.includes('authError'));
 const expired=await start();await query("update oauth_states set expires_at=now()-interval '1 second' where state=$1",[expired.state]);assert.equal((await callback(expired,dupeProfile)).status,400);
 const expiredHandoff=await callback(await start(),dupeProfile),ticket=new URL(expiredHandoff.headers.Location).searchParams.get('ticket');
 await query("update oauth_handoffs set expires_at=now()-interval '1 second' where token_hash=$1",[crypto.createHash('sha256').update(ticket).digest('hex')]);
 assert.equal((await request('/api/auth/google/complete?ticket='+ticket)).headers['Set-Cookie'],undefined);
 console.log('PASS: concurrent first enrollment/different states, later retries do not duplicate/reset; state and handoff replay/expiry denied');

 // Advance stored dates rather than patching the application clock or waiting.
 const setDue=async interval=>query(`update organization_subscriptions set trial_started_at=now()-interval '${interval}'-interval '720 hours',trial_ends_at=now()-interval '${interval}',due_at=now()-interval '${interval}' where organization_id=$1`,[pygOrg]);
 await setDue('47 hours');assert.equal((await me(pyg.cookie)).subscription.status,'grace');
 assert.equal((await request('/api/agency/clients',{cookie:pyg.cookie})).status,200);
 const client=await insert("insert into agency_clients(organization_id,name) values($1,'Trial owned fixture')",[pygOrg]);
 const project=await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Trial project')",[pygOrg,client]);
 const order=await insert("insert into agency_work_orders(organization_id,project_id,title) values($1,$2,'Trial order')",[pygOrg,project]);
 for(const path of ['/api/metrics','/api/agency/inventory','/api/agency/presence/projects?ids='+project,`/api/agency/work-orders/${order}/checklist`])assert.equal((await request(path,{cookie:pyg.cookie})).status,200,`live route before suspension: ${path}`);
 await setDue('48 hours');
 const suspended=await me(pyg.cookie);assert.equal(suspended.subscription.status,'suspended');assert.equal(suspended.subscription.hasAccess,false);assert.equal(suspended.role,'owner');
 const privateRoutes=[
  ['/api/agency/clients','GET'],['/api/agency/clients','POST',{name:'Must not be created'}],
  ['/api/metrics','GET'],['/api/metrics','POST',{}],['/api/hub/overview','GET'],
  ['/api/agency/presence/projects?ids='+project,'GET'],['/api/agency/presence/heartbeat','POST',{tab_id:crypto.randomUUID(),project_id:String(project),visible:true,active:true}],
  ['/api/agency/inventory','GET'],['/api/agency/inventory','POST',{}],
  ['/api/agency/reports','GET'],[`/api/agency/clients/${client}/reporting`,'GET'],[`/api/agency/clients/${client}/reporting`,'PATCH',{}],
  [`/api/agency/work-orders/${order}/checklist`,'GET'],[`/api/agency/work-orders/${order}/checklist/items`,'POST',{text:'Blocked',expected_version:'0'}],
  ['/api/auth/organizations','POST',{name:'Blocked new company',slug:'blocked-new-company'}]
 ];
 const beforeBlockedClients=await count('agency_clients'),beforeBlockedOrgs=await count('organizations');
 for(const [path,method,payload] of privateRoutes){const r=await request(path,{cookie:pyg.cookie,method,payload});assert.equal(r.status,402,`${method} ${path}`);assert.equal(r.data.code,'SUBSCRIPTION_REQUIRED');}
 assert.equal(await count('agency_clients'),beforeBlockedClients);assert.equal(await count('organizations'),beforeBlockedOrgs);
 assert.equal((await rows('select * from agency_presence_tabs where organization_id=$1',[pygOrg])).length,0);
 assert.equal((await rows('select * from agency_work_checklist_items where organization_id=$1',[pygOrg])).length,0);
 const state=await request('/api/billing/subscription',{cookie:pyg.cookie});assert.equal(state.status,200);assert.equal(state.data.status,'suspended');assert.equal(state.data.canManage,true);
 for(const path of ['/api/billing/checkout','/api/billing/portal'])assert.equal((await request(path,{cookie:pyg.cookie,method:'POST',payload:{}})).status,503,'unconfigured provider fails closed without fetch');
 const expiredSub=await rows('select * from organization_subscriptions where organization_id=$1',[pygOrg]);
 const retryExpired=await signup({email:'prior-trial@example.invalid',email_verified:true},'USD');assert.equal((await me(retryExpired.cookie)).subscription.status,'suspended');
 assert.deepEqual(await rows('select * from organization_subscriptions where organization_id=$1',[pygOrg]),expiredSub);
 assert.equal((await request('/api/auth/organizations',{cookie:pyg.cookie})).status,200);
 const switched=await request('/api/auth/switch-organization',{cookie:pyg.cookie,method:'POST',payload:{organizationId:existing}});assert.equal(switched.status,200);
 assert.equal((await me(cookieOf(switched))).role,'viewer');assert.equal((await me(cookieOf(switched))).subscription.status,'unmanaged');
 const suspendedSlug=(await rows('select slug from organizations where id=$1',[pygOrg]))[0].slug;
 const assertOverviewScope=response=>{
  assert.equal(response.status,200);
  assert.deepEqual(response.data.organizations.map(o=>o.slug).sort(),['trial-existing','trial-source-demo']);
  assert(!response.data.organizations.some(o=>o.slug===suspendedSlug),'switching to another accessible company must not expose suspended-company aggregates');
  assert(!response.data.organizations.some(o=>o.slug===orgRow.slug),'unrelated paid/trial tenant must not appear either');
 };
 // Optional Hub integration fixture: never load the unshipped Dadoo migration.
 // If a worktree schema already includes the table, preserve it by renaming
 // inside this ephemeral DB; test absence and a minimal four-column relation.
 const hadMetrics=Boolean((await rows("select to_regclass('public.hub_metric_values') as relation"))[0].relation);
 assert.equal((await rows("select to_regclass('public.trial_fixture_saved_hub_metrics') as relation"))[0].relation,null);
 if(hadMetrics)await query('alter table public.hub_metric_values rename to trial_fixture_saved_hub_metrics');
 try{
  const absent=await request('/api/hub/overview',{cookie:cookieOf(switched)});assertOverviewScope(absent);
  assert.equal(absent.data.metricsAvailable,false);
  for(const organization of absent.data.organizations){
   for(const key of ['revenue','collected','leads','sales'])assert.equal(organization[key],null,`${key} must be unavailable, not invented zero`);
   for(const [key,value] of Object.entries(organization))if(!['slug','name'].includes(key))assert.equal(value,null,`absent integration cannot fabricate ${key}`);
  }
  await query('create table public.hub_metric_values(organization_id bigint not null,metric_key text not null,value numeric not null,period_end date not null)');
  const metrics=[['revenue',12.5],['revenue',7.25],['collected',8.5],['leads',3],['sales',2]];
  for(const [key,value] of metrics)await query('insert into public.hub_metric_values values($1,$2,$3,current_date)',[existing,key,value]);
  // Sentinels would visibly alter totals if either tenant or date filtering fails.
  for(const org of [pygOrg,usdOrg])for(const key of ['revenue','collected','leads','sales'])await query('insert into public.hub_metric_values values($1,$2,9000,current_date)',[org,key]);
  await query("insert into public.hub_metric_values values($1,'revenue',9999,current_date-31)",[existing]);
  const populated=await request('/api/hub/overview',{cookie:cookieOf(switched)});assertOverviewScope(populated);
  assert.notEqual(populated.data.metricsAvailable,false);
  const allowed=populated.data.organizations.find(o=>o.slug==='trial-existing');
  for(const [key,total] of Object.entries({revenue:19.75,collected:8.5,leads:3,sales:2})){
   assert(['string','number'].includes(typeof allowed[key]));assert.equal(Number(allowed[key]),total,`exact authorized ${key} total`);
  }
  assert.equal((await request('/api/hub/overview',{cookie:pyg.cookie})).status,402,'populated integration does not bypass suspension');
 }finally{
  await query('drop table if exists public.hub_metric_values');
  if(hadMetrics)await query('alter table public.trial_fixture_saved_hub_metrics rename to hub_metric_values');
 }
 assert.equal(Boolean((await rows("select to_regclass('public.hub_metric_values') as relation"))[0].relation),hadMetrics,'optional integration restored to its original existence');
 console.log('PASS: optional Hub absent => null totals/metricsAvailable=false; minimal fixture => exact allowed totals, suspended/foreign/old metrics excluded; fixture removed');
 assert.equal((await request('/api/auth/logout',{cookie:retryExpired.cookie,method:'POST'})).status,200);
 assert.equal((await request('/api/auth/me',{cookie:retryExpired.cookie})).status,401);
 console.log('PASS: 47h grace / 48h suspension, private reads/writes blocked, role preserved, billing/status/switch/logout retained and retry cannot renew trial');

 const viewer=await insert("insert into users(email,password_hash) values('trial-viewer@example.invalid','unused')");
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')",[pygOrg,viewer]);
 const viewerCookie=await fixtureCookie(viewer,pygOrg);
 assert.equal((await me(viewerCookie)).role,'viewer');assert.equal((await request('/api/billing/subscription',{cookie:viewerCookie})).data.canManage,false);
 assert.equal((await request('/api/agency/clients',{cookie:viewerCookie})).status,402);
 for(const path of ['/api/billing/checkout','/api/billing/portal']){
  assert.equal((await request(path,{cookie:viewerCookie,method:'POST',payload:{}})).status,403);
  assert.equal((await request(path,{method:'POST',payload:{}})).status,401);
 }
 assert.equal((await request('/api/billing/subscription')).status,401);
 assert.equal((await me(priorCookie)).subscription.status,'unmanaged');assert.equal((await request('/api/agency/clients',{cookie:priorCookie})).status,200);
 assert.equal((await rows('select * from organization_subscriptions where organization_id=$1',[existing])).length,0);
 const demoCookie=await fixtureCookie(priorUser,sourceDemo),demoUser=await me(demoCookie);
 assert.equal(demoUser.subscription.status,'demo');assert.equal(demoUser.subscription.canManage,false);assert.equal(demoUser.subscription.hasAccess,true);
 assert.equal((await request('/api/agency/clients',{cookie:demoCookie})).status,200);assert.equal((await rows('select * from organization_subscriptions where organization_id=$1',[sourceDemo])).length,0);
 // Existing authorized company creation explicitly starts a NEW trial only.
 const managed=await request('/api/auth/organizations',{cookie:usd.cookie,method:'POST',payload:{name:'Manager created fixture',slug:'manager-created-trial',billingCurrency:'PYG'}});
 assert.equal(managed.status,201);await assertTrial(managed.data.organization.id,'PYG');
 assert.equal((await request('/api/auth/organizations',{cookie:priorCookie,method:'POST',payload:{name:'Viewer cannot create',slug:'viewer-cannot-create'}})).status,403);
 assert.equal(forbiddenCalls,0);assert.equal(connections,0);assert.deepEqual(databaseErrors,[],'no hidden database errors');
 console.log(`PASS: viewer cannot pay, unmanaged tenants/demo exempt, authorized new-company trial; ${requests} real handler requests, ${migrations.length} registered migrations, Google responses mocked only`);
}finally{await pg.close();}
