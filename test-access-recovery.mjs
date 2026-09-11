// node --experimental-vm-modules test-access-recovery.mjs
// Real handlers/local modules, clean committed schema, isolated PGlite; no sockets/providers.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
assert(vm.SourceTextModule,'Use --experimental-vm-modules');
const root=fileURLToPath(new URL('.',import.meta.url)),pg=new PGlite();
const source=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
await pg.exec(execFileSync('git',['show','HEAD:schema.sql'],{cwd:root,encoding:'utf8'}));
const init=source.slice(source.indexOf('async function init()'),source.indexOf('async function provisionOwner('));
const migrations=[...init.matchAll(/['"](?:migrations\/)?(\d{8}_[\w-]+\.sql)['"]/g)].map(m=>m[1]).filter(f=>f!=='20260908_dadoo_hub.sql');
for(const file of migrations)await pg.exec(await fs.readFile(new URL('./migrations/'+file,import.meta.url),'utf8'));
const query=(s,v)=>pg.query(s,v),rows=async(s,v)=>(await query(s,v)).rows;
const insert=async(s,v)=>(await rows(s+' returning id',v))[0].id;
let handler,calls=0,providerCalls=0,mode='success';
const profile={email:'oauth-recovery@example.invalid',name:'OAuth Fixture',email_verified:true};
async function google(url){
 providerCalls++;
 assert(['https://oauth2.googleapis.com/token','https://openidconnect.googleapis.com/v1/userinfo'].includes(url),'No external resource is allowed');
 const token=url.endsWith('/token'),phase=token?'token':'profile';
 if(mode===phase+'-throw')throw Error('fixture provider failure, do not expose');
 return {ok:mode!==phase+'-http',json:async()=>{
  if(mode===phase+'-json')throw Error('fixture malformed JSON, do not expose');
  if(token)return mode==='token-missing'?{}:{access_token:'fixture-only'};
  return mode==='profile-null'?null:mode==='profile-unverified'?{...profile,email_verified:false}:mode==='profile-unverified-string'?{...profile,email_verified:'true'}:mode==='profile-no-email'?{email_verified:true}:profile;
 }};
}
const context=vm.createContext({console,URL,URLSearchParams,Buffer,AbortSignal,TextEncoder,TextDecoder,fetch:google,
 process:{env:{GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',STRIPE_BILLING_ENABLED:'false'}},
 setTimeout,clearTimeout,setInterval(){throw Error('No background services');},clearInterval});
const modules=new Map();
async function load(spec,ref){
 const key=spec.startsWith('.')?new URL(spec,ref.identifier).href:spec;if(modules.has(key))return modules.get(key);
 let m;if(key.startsWith('file:'))m=new vm.SourceTextModule(await fs.readFile(new URL(key),'utf8'),{context,identifier:key,initializeImportMeta(meta){meta.url=key;}});
 else{
  const exports=key==='node:http'?{default:{createServer(fn){handler=fn;return {listen(){}};}}}:key==='pg'?{default:{Pool:class{query=query;connect=async()=>({query,release(){}});}}}:await import(key);
  m=new vm.SyntheticModule(Object.keys(exports),function(){for(const k of Object.keys(exports))this.setExport(k,exports[k]);},{context,identifier:key});
 }
 modules.set(key,m);return m;
}
const server=await load('./server.js',{identifier:import.meta.url});await server.link(load);await server.evaluate();
async function request(path,{cookie='',method='GET',payload}={}){
 calls++;const r={status:0,headers:{},body:''};
 await handler({url:path,method,headers:{host:'untrusted.example.invalid',cookie},socket:{remoteAddress:'fixture'},async *[Symbol.asyncIterator](){if(payload!==undefined)yield JSON.stringify(payload);}},
 {setHeader(k,v){r.headers[k]=v;},writeHead(status,h){r.status=status;Object.assign(r.headers,h);},end(b){r.body=b||'';}});
 return {...r,data:JSON.parse(r.body||'{}')};
}
const org=(await rows("select id from organizations where slug='scale'"))[0].id;
const owner=await insert("insert into users(email,password_hash) values('recovery-owner@example.invalid','fixture')");
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,owner]);
async function session(user,organization=org){const token=crypto.randomUUID();await query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '1 day')",[token,user,organization]);return 'scale_session='+token;}
const ownerCookie=await session(owner);
async function invitation(role='editor'){
 const r=await request('/api/agency/invite-links',{cookie:ownerCookie,method:'POST',payload:{role,mode:'approval'}});assert.equal(r.status,200);return {...r.data,token:new URL(r.data.url).searchParams.get('token')};
}
async function applicant(link,email){
 const user=await insert('insert into users(email,password_hash) values($1,\'fixture\')',[email]);
 const id=await insert("insert into agency_access_requests(link_id,user_id,full_name) values($1,$2,'Applicant')",[link.id,user]);
 return {user,id,cookie:await session(user)};
}
const status=async cookie=>(await request('/api/invitations/status',{cookie})).data;
const list=async()=>(await request('/api/agency/access-requests',{cookie:ownerCookie})).data.requests;
const decide=(id,action)=>request('/api/agency/access-requests/'+id,{cookie:ownerCookie,method:'PATCH',payload:{action}});
try{
 // Bug A: both surfaces agree, approval fails closed, recorded decisions stay untouched.
 for(const kind of ['revoked','expired','used']){
  const link=await invitation(),a=await applicant(link,kind+'@example.invalid');
  assert.equal((await status(a.cookie)).status,'pending');assert.equal((await list()).find(r=>String(r.id)===String(a.id)).status,'pending');
  if(kind==='revoked')assert.equal((await request('/api/agency/invite-links/'+link.id,{cookie:ownerCookie,method:'DELETE'})).status,200);
  if(kind==='expired')await query('update agency_invite_links set expires_at=now() where id=$1',[link.id]);
  if(kind==='used')await query('update agency_invite_links set used_at=now() where id=$1',[link.id]);
  const pending=await status(a.cookie);assert.equal(pending.status,'unavailable');assert.equal(pending.unavailableReason,kind);
  const admin=(await list()).find(r=>String(r.id)===String(a.id));assert.equal(admin.status,'unavailable');assert.equal(admin.unavailableReason,kind);
  assert.equal((await decide(a.id,'approve')).status,409);
  assert.equal((await rows('select * from organization_members where user_id=$1',[a.user])).length,0);
  assert.equal((await rows('select status from agency_access_requests where id=$1',[a.id]))[0].status,'pending');
  assert.equal((await request('/api/agency/clients',{cookie:a.cookie})).status,401);
  assert.equal((await decide(a.id,'reject')).status,200);assert.equal((await status(a.cookie)).status,'rejected');
 }
 const goodLink=await invitation('finance'),approved=await applicant(goodLink,'approved@example.invalid');
 assert.equal((await decide(approved.id,'approve')).status,200);
 await query("update agency_invite_links set revoked_at=now(),expires_at=now()-interval '1 day' where id=$1",[goodLink.id]);
 assert.equal((await status(approved.cookie)).status,'approved');assert.equal((await status(approved.cookie)).role,'finance');
 assert.equal((await rows('select role,active from organization_members where user_id=$1',[approved.user]))[0].active,true);
 await query('update organization_members set active=false where user_id=$1',[approved.user]);
 assert.equal((await status(approved.cookie)).status,'unavailable');
 assert.equal((await rows('select status from agency_access_requests where id=$1',[approved.id]))[0].status,'approved');
 const oldLink=await invitation('production'),old=await applicant(oldLink,'existing-access@example.invalid');
 await query("insert into organization_members(organization_id,user_id,role,active,removed_at) values($1,$2,'viewer',false,now())",[org,old.user]);
 assert.equal((await status(old.cookie)).status,'pending','a suspended member with a fresh invitation must keep seeing the approval wait state');
 assert.equal((await list()).find(r=>String(r.id)===String(old.id)).status,'pending','owners must be able to approve a suspended member again');
 assert.equal((await decide(old.id,'approve')).status,200);
 assert.deepEqual((await rows('select role,active,removed_at from organization_members where user_id=$1 and organization_id=$2',[old.user,org]))[0],{role:'production',active:true,removed_at:null});
 const inactiveLink=await invitation(),inactive=await applicant(inactiveLink,'inactive-org@example.invalid');
 await query('update organizations set active=false where id=$1',[org]);assert.equal((await status(inactive.cookie)).unavailableReason,'organization_unavailable');
 await query('update organizations set active=true where id=$1',[org]);
 const stranger=await insert("insert into users(email,password_hash) values('stranger@example.invalid','fixture')");
 assert.equal((await request('/api/invitations/status',{cookie:await session(stranger)})).status,401);
 console.log('PASS bug A: requester/admin unavailable, expiry boundary, revoked/used, no approval/private access, reject allowed, approved membership preserved');

 // Bug B: only validated+consumed state chooses a fixed app route; never create identities/access.
 const retryLink=await invitation();
 const tables=['users','organization_members','organizations','organization_subscriptions','sessions','agency_access_requests','agency_invite_links','oauth_handoffs','os_trial_registrations'];
 const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,JSON.stringify(await rows(`select * from ${table} order by 1`))])));
 async function start(flow){
  const params=new URLSearchParams(flow==='trial'?{signup:'1',company:'Retry Agency',currency:'USD',consent:'1'}:flow==='invite'?{invite:retryLink.token}:{});
  params.set('next','https://evil.example.invalid');
  const r=await request('/api/auth/google/start?'+params);assert.equal(r.status,302);
  return {state:new URL(r.headers.Location).searchParams.get('state'),cookie:r.headers['Set-Cookie'].split(';')[0]};
 }
 for(const flow of ['login','trial','invite'])for(const failure of ['cancel','missing-code','error-with-code','token-http','token-json','token-missing','token-throw','profile-http','profile-json','profile-null','profile-throw','profile-unverified','profile-unverified-string','profile-no-email']){
  mode=failure;const before=await snapshot(),started=await start(flow),beforeCalls=providerCalls;
  const params=new URLSearchParams({state:started.state,redirect:'https://evil.example.invalid',error_description:'PRIVATE PROVIDER DETAIL'});
  if(failure!=='missing-code'&&failure!=='cancel')params.set('code','fixture');
  if(failure==='cancel'||failure==='error-with-code')params.set('error','access_denied');
  const r=await request('/api/auth/google/callback?'+params,{cookie:started.cookie});assert.equal(r.status,302,flow+' '+failure);
  const destination=new URL(r.headers.Location);assert.equal(destination.origin,'https://app.scaleparaguay.com');assert.equal(destination.pathname,flow==='trial'?'/registro':flow==='invite'?'/invitacion':'/');
  assert.match(destination.searchParams.get(flow==='login'?'authError':'error'),/intentá nuevamente/i);
  assert(!r.headers.Location.includes('evil'));assert(!r.headers.Location.includes('PRIVATE'));assert(!r.headers.Location.includes(retryLink.token));
  assert.match(r.headers['Set-Cookie'],/^scale_oauth_state=; Max-Age=0;/);assert(!r.headers['Set-Cookie'].includes('scale_session'));
  assert.equal((await rows('select * from oauth_states where state=$1',[started.state])).length,0);
  if(['cancel','missing-code','error-with-code'].includes(failure))assert.equal(providerCalls,beforeCalls);
  const atReplay=providerCalls;assert.equal((await request('/api/auth/google/callback?'+params,{cookie:started.cookie})).status,400);assert.equal(providerCalls,atReplay);
  assert.deepEqual(await snapshot(),before,'OAuth failure changed identity, invite, agency, membership, trial or session');
 }
 const started=await start('trial'),invalidCalls=providerCalls;
 const wrong=await request('/api/auth/google/callback?'+new URLSearchParams({state:started.state,code:'fixture',next:'https://evil.example.invalid'}),{cookie:'scale_oauth_state=forged'});
 assert.equal(wrong.status,302);assert.equal(new URL(wrong.headers.Location).pathname,'/');assert(wrong.headers.Location.includes('authError'));assert.equal(providerCalls,invalidCalls);
 assert.equal((await rows('select state from oauth_states where state=$1',[started.state])).length,1,'mismatched cookie cannot consume a real flow');
 await query('update oauth_states set expires_at=now() where state=$1',[started.state]);
 assert.equal((await request('/api/auth/google/callback?state='+started.state,{cookie:started.cookie})).status,400);assert.equal(providerCalls,invalidCalls);
 console.log(`PASS bug B: 42 recovery scenarios, validated single-use state, cancellation/transport/JSON/unverified profile errors, fixed app routes, no access writes; ${calls} handler requests total`);
}finally{await pg.close();}
