// node --experimental-vm-modules --test test-invitation-full-flow-regression.mjs
// Based on the existing access-recovery VM harness; no runtime files or external services.
// Real handlers/local modules, clean committed schema, isolated PGlite; no sockets/providers.
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
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
const profile={email:'oauth-recovery@example.invalid',name:'OAuth Fixture',picture:'https://lh3.googleusercontent.com/fixture-photo',email_verified:true};
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

const org=await insert("insert into organizations(slug,name) values('default-first','A First')");
const second=await insert("insert into organizations(slug,name) values('default-second','Z Second')");
const foreign=await insert("insert into organizations(slug,name) values('default-foreign','Foreign')");
const demo=await insert("insert into organizations(slug,name) values('scale-demo-controles-20260908','Demo')");
const password='fixture-password-123';
const uid=await insert('insert into users(email,password_hash) values($1,$2)',[profile.email,await bcrypt.hash(password,4)]);
const other=await insert("insert into users(email,password_hash) values('other-default@example.invalid','unused')");
await query("insert into organization_members(organization_id,user_id,role) values($1,$3,'owner'),($2,$3,'viewer'),($4,$5,'owner')",[org,second,uid,foreign,other]);
async function cookieFor(user,organization){const token=crypto.randomUUID();await query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '1 day')",[token,user,organization]);return 'scale_session='+token;}
const cookie=await cookieFor(uid,org),otherCookie=await cookieFor(other,foreign);
const set=(organizationId,as=cookie)=>request('/api/auth/default-organization',{cookie:as,method:'POST',payload:{organizationId}});
const list=(as=cookie)=>request('/api/auth/organizations',{cookie:as});
const orgOf=async r=>(await rows('select organization_id from sessions where id=$1',[r.headers['Set-Cookie'].split(';')[0].split('=')[1]]))[0].organization_id;
async function passwordLogin(){return request('/api/auth/login',{method:'POST',payload:{email:profile.email,password}});}
async function googleStart(params=''){
 const start=await request('/api/auth/google/start'+params);assert.equal(start.status,302);
 const state=new URL(start.headers.Location).searchParams.get('state');
 const callback=await request('/api/auth/google/callback?'+new URLSearchParams({state,code:'fixture'}),{cookie:start.headers['Set-Cookie'].split(';')[0]});
 assert.equal(callback.status,302);return new URL(callback.headers.Location);
}
const complete=target=>request('/api/auth/google/complete'+target.search);
assert.equal((await list()).data.defaultOrganizationId,null);
assert.equal((await list()).data.organizations.find(o=>o.id===demo).isDemo,true);
assert.equal((await set(second,'')).status,401);
assert.equal((await set(foreign)).status,403);
assert.equal((await set(demo)).status,403);
for(const id of ['abc',0,-1,1.2,{},'9223372036854775808'])assert.equal((await set(id)).status,400);
assert.equal((await request('/api/auth/default-organization',{cookie,method:'POST',payload:{organizationId:second,userId:other}})).status,400);
assert.equal((await set(second)).status,200);
assert.equal((await list()).data.defaultOrganizationId,String(second));
assert.equal((await list()).data.currentOrganizationId,org,'Saving does not switch the current session');
assert.equal((await list(otherCookie)).data.defaultOrganizationId,null,'Preference belongs only to authenticated user');
assert.equal((await rows('select default_organization_id from user_login_preferences where user_id=$1',[uid]))[0].default_organization_id,second);
assert.equal(await orgOf(await passwordLogin()),second);
let target=await googleStart(),r=await complete(target);
assert.equal(await orgOf(r),second);assert.equal(new URL(r.headers.Location).search,'','Saved default bypasses company chooser');
assert.equal((await complete(target)).headers['Set-Cookie'],undefined,'OAuth handoff stays single-use');

// Stale defaults never select removed/suspended membership or inactive organization.
await query('update organization_members set active=false where organization_id=$1 and user_id=$2',[second,uid]);
assert.equal((await set(second)).status,403);assert.equal((await list()).data.defaultOrganizationId,null);
assert.equal(await orgOf(await passwordLogin()),org);
r=await complete(await googleStart());assert.equal(await orgOf(r),org);
await query('update organization_members set active=true,removed_at=now() where organization_id=$1 and user_id=$2',[second,uid]);
assert.equal((await set(second)).status,403);assert.equal(await orgOf(await passwordLogin()),org);
await query('update organization_members set removed_at=null where organization_id=$1 and user_id=$2',[second,uid]);
await query('update organizations set active=false where id=$1',[second]);assert.equal((await set(second)).status,403);assert.equal(await orgOf(await passwordLogin()),org);
await query('update organizations set active=true where id=$1',[second]);
target=await googleStart();
await query('update organization_members set active=false where organization_id=$1 and user_id=$2',[second,uid]);
assert.equal(await orgOf(await complete(target)),org,'Revalidate membership between callback and completion');
await query('update organization_members set active=true where organization_id=$1 and user_id=$2',[second,uid]);

// Every demo form is ineligible, including a private copy and a demo guest.
const privateDemo=await insert("insert into organizations(slug,name,demo_owner_user_id,demo_source_id,demo_expires_at) values('default-private-demo','Private demo',$1,$2,now()+interval '1 day')",[uid,demo]);
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[privateDemo,uid]);
assert.equal((await set(privateDemo)).status,403);
assert.equal((await set(org,await cookieFor(uid,privateDemo))).status,403);
const demoSource=await insert("insert into organizations(slug,name,demo_source_id) values('default-source-demo','Source demo',$1)",[demo]);
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[demoSource,uid]);
assert.equal((await set(demoSource)).status,403);
assert.equal((await list()).data.organizations.find(o=>o.id===demoSource).isDemo,true);
assert.equal((await list()).data.organizations.find(o=>o.id===org).isDemo,false);

// Explicit invitation target wins over the persisted default.
const invite=await request('/api/agency/invite-links',{cookie,method:'POST',payload:{role:'editor',mode:'single'}});
assert.equal(invite.status,200);
r=await complete(await googleStart('?invite='+new URL(invite.data.url).searchParams.get('token')));
assert.equal(await orgOf(r),org);
assert.equal((await list()).data.defaultOrganizationId,String(second));
// Approval-mode handoff to another company stays pending, without membership.
const approval=await request('/api/agency/invite-links',{cookie:otherCookie,method:'POST',payload:{role:'editor',mode:'approval'}});
r=await complete(await googleStart('?invite='+new URL(approval.data.url).searchParams.get('token')));
assert.equal(await orgOf(r),foreign);assert.equal(new URL(r.headers.Location).pathname,'/acceso-pendiente');
assert.equal((await rows('select 1 from organization_members where organization_id=$1 and user_id=$2',[foreign,uid])).length,0);
assert.equal((await request('/api/auth/default-organization',{cookie:r.headers['Set-Cookie'].split(';')[0],method:'POST',payload:{organizationId:org}})).status,401);

// Trial handoff remains its explicit destination even with an existing preference.
const trialTicket='fixture-trial-ticket';
await query("insert into oauth_handoffs(token_hash,user_id,organization_id,expires_at,trial_registration) values($1,$2,$3,now()+interval '1 minute',true)",[crypto.createHash('sha256').update(trialTicket).digest('hex'),uid,org]);
r=await request('/api/auth/google/complete?ticket='+trialTicket);assert.equal(await orgOf(r),org);assert.equal(new URL(r.headers.Location).pathname,'/produccion');
assert.equal((await set(null)).data.defaultOrganizationId,null);
assert.equal((await list()).data.defaultOrganizationId,null);
assert.equal(await orgOf(await passwordLogin()),org);
r=await complete(await googleStart());assert.equal(await orgOf(r),org);assert.equal(new URL(r.headers.Location).searchParams.get('chooseCompany'),'1');
// Migration can be rerun without resetting a saved preference.
await set(second);
await pg.exec(await fs.readFile(new URL('./migrations/20260911_default_login_organization.sql',import.meta.url),'utf8'));
assert.equal((await list()).data.defaultOrganizationId,String(second));
// Actual Google trial callback must not route back to the saved login company.
r=await complete(await googleStart('?'+new URLSearchParams({signup:'1',company:'Trial default fixture',currency:'USD',consent:'1'})));
const trialOrg=await orgOf(r);assert.notEqual(trialOrg,second);assert.notEqual(trialOrg,org);
assert.equal(new URL(r.headers.Location).pathname,'/produccion');
assert.equal((await list()).data.defaultOrganizationId,String(second));
await pg.close();
console.log('PASS: persisted default company, authenticated setter/list, both login methods, stale defaults, handoff revalidation, tenant/demo isolation, invitation/trial targets, clear and migration rerun.');
