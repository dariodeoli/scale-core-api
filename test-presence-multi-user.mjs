// Run: node --experimental-vm-modules test-presence-multi-user.mjs
// Integrated server/session/presence/profile handlers, in-memory PostgreSQL.
// No browser, sockets, production database, external fetch, or background jobs.
// Unlike test-presence.mjs, this never supplies a pre-resolved user/session mock.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

assert(vm.SourceTextModule, 'Run with node --experimental-vm-modules test-presence-multi-user.mjs');
const pg=new PGlite();
const sql=async file=>pg.exec(await fs.readFile(new URL(file,import.meta.url),'utf8'));
await sql('schema.sql');
for(const file of [
 '20260908_treasury_ledger','20260908_google_oauth','20260908_people_commissions_comments',
 '20260908_operations_complete','20260908_referral_discounts','20260908_collaborator_profiles',
 '20260908_agency_suite','20260908_daily_controls','20260910_productivity',
 '20260910_profile_identity','20260910_demo_sessions','20260910_notifications',
 '20260910_client_links','20260910_client_lifecycle','20260910_invite_links',
 '20260910_currencies','20260910_company_currency','20260910_global_identity','20260910_presence'
])await sql(`migrations/${file}.sql`);

// Model a pg Pool with max=1: concurrent requests queue complete transactions.
// PGlite has a single connection; interleaving BEGIN/COMMIT would falsify the test.
let queue=Promise.resolve(),connections=0;
async function connect(){
 const previous=queue;let unlock;queue=new Promise(resolve=>{unlock=resolve;});await previous;
 connections++;let released=false;
 return {query:(s,v)=>pg.query(s,v),release(){assert(!released);released=true;connections--;unlock();}};
}
async function query(s,v){const c=await connect();try{return await c.query(s,v);}finally{c.release();}}
const insert=async(s,v)=>(await query(s+' returning id',v)).rows[0].id;
let handler,networkAttempts=0,listenCalls=0;
const serverSource=await fs.readFile(new URL('server.js',import.meta.url),'utf8');
const denyNetwork=async()=>{networkAttempts++;throw Error('External network is forbidden in this test');};
const originalFetch=globalThis.fetch;globalThis.fetch=denyNetwork;
const context=vm.createContext({console,URL,URLSearchParams,Buffer,fetch:denyNetwork,
 process:{env:{}},setTimeout,clearTimeout,setInterval,clearInterval});
const serverModule=new vm.SourceTextModule(serverSource,{
 context,identifier:new URL('server.js',import.meta.url).href,
 initializeImportMeta(meta){meta.url=new URL('server.js',import.meta.url).href;}
});
await serverModule.link(async spec=>{
 let exports;
 if(spec==='node:http')exports={default:{createServer:callback=>{handler=callback;return {listen(){listenCalls++;}};}}};
 else if(spec==='pg')exports={default:{Pool:class{query=query;connect=connect;}}};
 else exports=await import(spec);
 const keys=Object.keys(exports);
 return new vm.SyntheticModule(keys,function(){for(const key of keys)this.setExport(key,exports[key]);},{context});
});
await serverModule.evaluate();
assert.equal(typeof handler,'function');assert.equal(listenCalls,1);

let requestCount=0;
async function request(path,{cookie='',method='GET',payload}={}){
 assert(path==='/api/auth/me'||path.startsWith('/api/agency/presence/')||path==='/api/agency/productivity/profile','test routes stay inside the authorized scope');
 requestCount++;
 const result={status:0,headers:{},body:''};
 const req={url:path,method,headers:{host:'admin.scaleparaguay.com',cookie,'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'},
  async *[Symbol.asyncIterator](){if(payload!==undefined)yield JSON.stringify(payload);}};
 await handler(req,{setHeader(k,v){result.headers[k]=v;},writeHead(status,headers){result.status=status;Object.assign(result.headers,headers);},end(value){result.body=value||'';}});
 const data=JSON.parse(result.body||'{}');
 assert.equal(result.headers['Cache-Control'],'no-store');
 // Authentication cookies and internal session hashes must never be returned as presence data.
 if(path.startsWith('/api/agency/presence/'))for(const value of secrets)assert(!result.body.includes(value));
 return {...result,data};
}
const secrets=[];
async function loginFixture(user,organization){
 const token=crypto.randomBytes(32).toString('hex');secrets.push(token,crypto.createHash('sha256').update(token).digest('hex'));
 await query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '1 day')",[token,user,organization]);
 return {cookie:'scale_session='+token,token};
}
const presencePath='/api/agency/presence/';
const read=(suffix,as)=>request(presencePath+suffix,{cookie:as?.cookie});
const heartbeat=(as,tab,project,{active=false,visible=true,...extra}={})=>request(presencePath+'heartbeat',{
 cookie:as.cookie,method:'POST',payload:{tab_id:tab,project_id:project===null?null:String(project),active,visible,...extra}});
const profile=(as,payload)=>request('/api/agency/productivity/profile',{cookie:as.cookie,method:payload?'PATCH':'GET',payload});
const ids=rows=>rows.map(row=>String(row.id)).sort();

try{
 const org=await insert("insert into organizations(slug,name) values('presence-integration-a','Test agency A')");
 const other=await insert("insert into organizations(slug,name) values('presence-integration-b','Test agency B')");
 const ana=await insert("insert into users(email,password_hash) values('ana-presence@example.invalid','unused')");
 const bruno=await insert("insert into users(email,password_hash) values('bruno-presence@example.invalid','unused')");
 assert.notEqual(ana,bruno);
 for(const [organization,user,role] of [[org,ana,'owner'],[org,bruno,'editor'],[other,ana,'viewer'],[other,bruno,'owner']])
  await query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3)',[organization,user,role]);
 const client=await insert("insert into agency_clients(organization_id,name) values($1,'Test client A')",[org]);
 const otherClient=await insert("insert into agency_clients(organization_id,name) values($1,'Test client B')",[other]);
 const project=await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Shared test project')",[org,client]);
 const secondProject=await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Another test project')",[org,client]);
 const foreignProject=await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Foreign test project')",[other,otherClient]);
 const a=await loginFixture(ana,org),b=await loginFixture(bruno,org),aOther=await loginFixture(ana,other),bOther=await loginFixture(bruno,other);
 const authA=(await request('/api/auth/me',{cookie:a.cookie})).data.user;
 const authB=(await request('/api/auth/me',{cookie:b.cookie})).data.user;
 assert.equal(String(authA.id),String(ana));assert.equal(String(authB.id),String(bruno));assert.notEqual(authA.id,authB.id);
 assert.equal(authA.role,'owner');assert.equal(authB.role,'editor');
 assert.equal((await read('projects?ids='+project)).status,401);
 assert.equal((await read('projects?ids='+project,{cookie:'scale_session=unknown-test-session'})).status,401);
 assert.equal((await read('usage',b)).status,403);
 assert.equal((await read('usage',aOther)).status,403,'same user has a different role in the other tenant');
 console.log('PASS: real server cookie/session resolution, distinct users, owner-only usage and per-tenant roles');

 // Canonical profile edits through the real API, not direct fixture profile writes.
 assert.equal((await profile(a,{full_name:'Alex Compartido',photo_url:'https://example.invalid/ana.png'})).status,200);
 assert.equal((await profile(b,{full_name:'Alex Compartido',photo_url:'https://example.invalid/bruno.png'})).status,200);
 const aActive=crypto.randomUUID(),aViewing=crypto.randomUUID(),aSecond=crypto.randomUUID(),bViewing=crypto.randomUUID();
 const results=await Promise.all([
  heartbeat(a,aActive,project,{active:true}),heartbeat(a,aViewing,project),
  heartbeat(b,bViewing,project),heartbeat(a,aSecond,secondProject)
 ]);
 assert(results.every(result=>result.status===200));
 let people=(await read('project?projectId='+project,a)).data.people;
 assert.deepEqual(ids(people),[String(ana),String(bruno)].sort(),'equal names and duplicate tabs never merge distinct users');
 assert.equal(people.find(p=>String(p.id)===String(ana)).active,true);
 assert.equal(people.find(p=>String(p.id)===String(bruno)).active,false);
 assert.equal(people.find(p=>String(p.id)===String(ana)).photo_url,'https://example.invalid/ana.png');
 assert.equal(people.find(p=>String(p.id)===String(bruno)).photo_url,'https://example.invalid/bruno.png');
 const usage=(await read('usage',a)).data.people;
 for(const user of [ana,bruno])assert.equal(usage.find(p=>String(p.id)===String(user)).sessions,1,'each real token hashes to one usage session despite multiple tabs');
 // A new login for the same person increases usage sessions, not the avatar count.
 const aSecondLogin=await loginFixture(ana,org);
 await heartbeat(aSecondLogin,crypto.randomUUID(),project);
 assert.equal((await read('project?projectId='+project,a)).data.people.length,2);
 assert.equal((await read('usage',a)).data.people.find(p=>String(p.id)===String(ana)).sessions,2);
 console.log('PASS: queued concurrent requests, same-name distinct users, multiple tabs/logins and active versus viewing per project');

 await heartbeat(bOther,crypto.randomUUID(),foreignProject,{active:true});
 let batch=(await read('projects?ids='+[project,secondProject,foreignProject].join(','),a)).data.people;
 assert.equal(batch.length,3);assert(!batch.some(p=>String(p.project_id)===String(foreignProject)));
 assert.equal(batch.find(p=>String(p.project_id)===String(secondProject)).active,false);
 assert.equal((await read('project?projectId='+foreignProject,a)).status,404);
 assert.equal((await heartbeat(a,aActive,foreignProject)).status,404);
 assert.equal((await read('projects?ids='+project,aOther)).data.people.length,0);
 // Caller-controlled IDs cannot override the authenticated user/organization.
 await heartbeat(b,bViewing,project,{active:false,user_id:ana,organization_id:other});
 assert.equal((await query('select user_id,organization_id from agency_presence_tabs where tab_id=$1',[bViewing])).rows[0].organization_id,org);
 assert.equal((await query('select user_id from agency_presence_tabs where tab_id=$1',[bViewing])).rows[0].user_id,bruno);
 console.log('PASS: authenticated tenant filtering and payloads cannot forge another user or organization');

 // Changing identity in another real tenant propagates to presence immediately,
 // without a new heartbeat or changing this tenant's role.
 assert.equal((await profile(aOther,{full_name:'Ana Actualizada',photo_url:'https://example.invalid/new.png'})).status,200);
 people=(await read('project?projectId='+project,b)).data.people;
 assert.equal(people.find(p=>String(p.id)===String(ana)).name,'Ana Actualizada');
 assert.equal(people.find(p=>String(p.id)===String(ana)).photo_url,'https://example.invalid/new.png');
 assert.equal((await request('/api/auth/me',{cookie:a.cookie})).data.user.role,'owner');
 assert.equal((await request('/api/auth/me',{cookie:aOther.cookie})).data.user.role,'viewer');
 assert.equal((await profile(a,{photo_url:''})).status,200);
 assert.equal((await read('projects?ids='+project,b)).data.people.find(p=>String(p.id)===String(ana)).photo_url,null);
 assert.equal((await profile(b,{user_id:ana,full_name:'Spoofed'})).status,400);
 const demo=await insert("insert into organizations(slug,name,demo_owner_user_id,demo_expires_at) values('presence-private-demo','Demo',$1,now()+interval '1 day')",[ana]);
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[demo,ana]);
 const aDemo=await loginFixture(ana,demo);
 assert.equal((await profile(aDemo,{full_name:'Identidad Demo',photo_url:'https://example.invalid/demo.png'})).status,200);
 assert.equal((await read('projects?ids='+project,aDemo)).data.people.length,0);
 assert.equal((await heartbeat(aDemo,crypto.randomUUID(),project)).status,404);
 assert.equal((await read('project?projectId='+project,b)).data.people.find(p=>String(p.id)===String(ana)).name,'Ana Actualizada');
 console.log('PASS: canonical self-profile updates/photo removal propagate to presence; roles and private demo identity remain isolated');

 // Unlike the unit test, suspended callers are rejected by session() itself.
 await query('update organization_members set active=false where organization_id=$1 and user_id=$2',[org,bruno]);
 const before=(await query('select * from agency_presence_tabs where organization_id=$1 and user_id=$2 order by tab_id',[org,bruno])).rows;
 for(const suffix of ['project?projectId='+project,'projects?ids='+project,'usage'])assert.equal((await read(suffix,b)).status,401);
 assert.equal((await heartbeat(b,bViewing,project,{active:true})).status,401);
 assert.equal((await profile(b,{full_name:'Suspended edit'})).status,401);
 assert.deepEqual((await query('select * from agency_presence_tabs where organization_id=$1 and user_id=$2 order by tab_id',[org,bruno])).rows,before);
 assert.deepEqual(ids((await read('project?projectId='+project,a)).data.people),[String(ana)]);
 assert.equal((await read('projects?ids='+foreignProject,bOther)).status,200,'suspension does not affect a separate authorized tenant');
 await query('update organization_members set active=true,removed_at=now() where organization_id=$1 and user_id=$2',[org,bruno]);
 assert.equal((await read('projects?ids='+project,b)).status,401,'removed_at independently revokes caller access');
 await query("update organization_members set removed_at=null,role='viewer' where organization_id=$1 and user_id=$2",[org,bruno]);
 assert.equal((await read('projects?ids='+project,b)).status,200,'restored viewer may see presence');
 assert.equal((await read('usage',b)).status,403,'restoration does not grant owner permissions');
 await query("update organization_members set role='viewer' where organization_id=$1 and user_id=$2",[org,ana]);
 assert.equal((await read('usage',a)).status,403,'role downgrade applies to an existing cookie immediately');
 await query("update organization_members set role='owner' where organization_id=$1 and user_id=$2",[org,ana]);
 console.log('PASS: suspension/removal deny reads, heartbeat and profile writes; restoration/downgrade respect current membership roles');

 await query("update agency_presence_tabs set last_seen_at=now()-interval '76 seconds' where tab_id=$1",[aActive]);
 assert.equal((await read('project?projectId='+project,b)).data.people.find(p=>String(p.id)===String(ana)).active,false,'expired active tab does not keep fresh viewing tabs active');
 await query("update agency_presence_tabs set last_seen_at=now()-interval '76 seconds' where organization_id=$1 and user_id=$2",[org,ana]);
 assert.deepEqual(ids((await read('project?projectId='+project,b)).data.people),[String(bruno)]);
 await heartbeat(a,aViewing,project);
 await heartbeat(b,bViewing,project,{visible:false,active:true});
 assert.deepEqual(ids((await read('project?projectId='+project,a)).data.people),[String(ana)],'hidden input cannot advertise active presence');
 await query("update sessions set expires_at=now()-interval '1 second' where id=$1",[a.token]);
 assert.equal((await read('projects?ids='+project,a)).status,401);
 assert.equal((await heartbeat(a,aViewing,project,{active:true})).status,401);
 assert.equal((await read('projects?ids='+project,aSecondLogin)).status,200,'another valid login for the same user survives token expiry');
 await query('delete from sessions where id=$1',[aSecondLogin.token]);
 assert.equal((await read('projects?ids='+project,aSecondLogin)).status,401);
 await query('update organizations set active=false where id=$1',[other]);
 assert.equal((await read('projects?ids='+foreignProject,bOther)).status,401);
 assert.equal((await read('projects?ids='+project,b)).status,200);
 console.log('PASS: presence TTL, hidden state, token expiry/revocation and organization suspension');

 assert.equal(networkAttempts,0);assert.equal(connections,0);
 console.log(`PASS: ${requestCount} requests through the real server handler; 2 distinct fixture users; no browser, sockets, external services or shared server edits`);
}finally{
 globalThis.fetch=originalFetch;
 await pg.close();
}
