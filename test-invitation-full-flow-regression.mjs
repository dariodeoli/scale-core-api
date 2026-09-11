// node --experimental-vm-modules --test test-invitation-full-flow-regression.mjs
// Based on the existing access-recovery VM harness; no runtime files or external services.
// Real handlers/local modules, clean committed schema, isolated PGlite; no sockets/providers.
import assert from 'node:assert/strict';
import test from 'node:test';
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
const org=(await rows("select id from organizations where slug='scale'"))[0].id;
const owner=await insert("insert into users(email,password_hash) values('recovery-owner@example.invalid','fixture')");
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,owner]);
async function session(user,organization=org){const token=crypto.randomUUID();await query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '1 day')",[token,user,organization]);return 'scale_session='+token;}
const ownerCookie=await session(owner);
async function invitation(role='editor',mode='approval'){
 const r=await request('/api/agency/invite-links',{cookie:ownerCookie,method:'POST',payload:{role,mode}});assert.equal(r.status,200);return {...r.data,token:new URL(r.data.url).searchParams.get('token')};
}
async function applicant(link,email){
 const user=await insert('insert into users(email,password_hash) values($1,\'fixture\')',[email]);
 const id=await insert("insert into agency_access_requests(link_id,user_id,full_name) values($1,$2,'Applicant')",[link.id,user]);
 return {user,id,cookie:await session(user)};
}
const status=async cookie=>(await request('/api/invitations/status',{cookie})).data;
const list=async()=>(await request('/api/agency/access-requests',{cookie:ownerCookie})).data.requests;
const decide=(id,action)=>request('/api/agency/access-requests/'+id,{cookie:ownerCookie,method:'PATCH',payload:{action}});
async function login(link,email,allowRejected=false){
 profile.email=email;
 const start=await request('/api/auth/google/start?'+new URLSearchParams({invite:link.token}));
 assert.equal(start.status,302);
 const state=new URL(start.headers.Location).searchParams.get('state');
 const callback=await request('/api/auth/google/callback?'+new URLSearchParams({state,code:'fixture'}),{cookie:start.headers['Set-Cookie'].split(';')[0]});
 assert.equal(callback.status,302);
 const target=new URL(callback.headers.Location);
 if(allowRejected&&target.pathname==='/invitacion'){
  assert.ok(target.searchParams.get('error'),'a refused repeat claim must explain why');
  return {rejected:true};
 }
 assert.equal(target.pathname,'/core-api/api/auth/google/complete',callback.headers.Location);
 const complete=await request('/api/auth/google/complete'+target.search);
 assert.equal(complete.status,302);
 return {cookie:complete.headers['Set-Cookie'].split(';')[0],path:new URL(complete.headers.Location).pathname};
}
async function member(email,kind){
 const user=await insert("insert into users(email,password_hash) values($1,'fixture')",[email]);
 if(kind!=='new')await query("insert into organization_members(organization_id,user_id,role,active,removed_at) values($1,$2,'viewer',$3,case when $4 then now() else null end)",[org,user,kind==='active',kind==='removed']);
 return user;
}
const membership=async user=>(await rows('select role,active,removed_at from organization_members where user_id=$1 and organization_id=$2',[user,org]))[0];
try{
 for(const kind of ['new','active','suspended','removed'])for(const mode of ['single','approval']){
  await test(kind+' member completes Google invitation in '+mode+' mode',async()=>{
   const email=kind+'-'+mode+'@example.invalid',user=await member(email,kind),link=await invitation('editor',mode);
   const before=await membership(user),signed=await login(link,email);
   const pending=kind==='suspended'||kind==='removed'||(kind==='new'&&mode==='approval');
   if(!pending){
    assert.equal((await membership(user)).role,kind==='active'?'viewer':'editor');
    assert.equal((await request('/api/auth/me',{cookie:signed.cookie})).status,200);
    const personal=(await rows('select full_name,photo_url from user_personal_identities where user_id=$1',[user]))[0];
    assert.equal(personal.full_name,profile.name);assert.equal(personal.photo_url,profile.picture);
    assert.equal(signed.path,'/');
    if(kind==='active'){
     assert.deepEqual(await membership(user),before,'existing active access must retain its role');
     assert.equal((await rows('select count(*)::int as n from agency_access_requests where link_id=$1',[link.id]))[0].n,0);
    }else{
     assert.equal((await request('/api/invitations/preview?token='+link.token)).status,410);
     assert.equal((await request('/api/auth/google/start?invite='+link.token)).status,410);
    }
    return;
   }
   assert.equal(signed.path,'/acceso-pendiente');
   assert.deepEqual(await membership(user),before,'pending invitation must not grant or reactivate membership');
   for(const path of ['/api/auth/me','/api/agency/clients','/api/agency/access-requests'])
    assert.equal((await request(path,{cookie:signed.cookie})).status,401,path);
   const item=(await list()).find(r=>r.email===email);
   assert.equal(item.status,'pending');
   // Soft assertion lets this same test verify approval even when requester state is broken.
   const requester=await status(signed.cookie);
   assert.equal((await decide(item.id,'approve')).status,200);
   assert.deepEqual(await membership(user),{role:'editor',active:true,removed_at:null});
   assert.equal((await status(signed.cookie)).status,'approved');
   assert.equal((await request('/api/auth/me',{cookie:signed.cookie})).status,200);
   assert.equal((await rows('select photo_url from user_personal_identities where user_id=$1',[user]))[0].photo_url,profile.picture);
   assert.equal((await decide(item.id,'approve')).status,409);
   const persisted=(await rows('select used_at,account_count from agency_invite_links where id=$1',[link.id]))[0];
   assert.equal(persisted.account_count,1);
   assert.equal(Boolean(persisted.used_at),mode==='single');
   if(mode==='single')assert.equal((await request('/api/auth/google/start?invite='+link.token)).status,410);
   assert.equal(requester.status,'pending','requester and owner must agree before approval: '+JSON.stringify(requester));
  });
 }
 await test('invalid, expired, revoked and consumed tokens fail before login with no OAuth state or provider call',async()=>{
  const invalid=['bad','x'.repeat(43)];
  for(const kind of ['expired','revoked','used']){
   const link=await invitation();
   await query('update agency_invite_links set '+({expired:"expires_at=now()-interval '1 second'",revoked:'revoked_at=now()',used:'used_at=now()'}[kind])+' where id=$1',[link.id]);
   invalid.push(link.token);
  }
  const before=(await rows('select count(*)::int as n from oauth_states'))[0].n,external=providerCalls;
  for(const token of invalid)for(const path of ['/api/invitations/preview?token=','/api/auth/google/start?invite='])
   assert.equal((await request(path+token)).status,410);
  assert.equal((await rows('select count(*)::int as n from oauth_states'))[0].n,before);
  assert.equal(providerCalls,external);
 });
 await test('one preview counts one visit; OAuth start and completion do not count extra clicks',async()=>{
  const link=await invitation(),clicks=async()=>(await rows('select click_count from agency_invite_links where id=$1',[link.id]))[0].click_count;
  assert.equal(await clicks(),0);
  const {resolveInvite}=modules.get(new URL('./invite-links.js',import.meta.url).href).namespace;
  assert.equal((await resolveInvite({query},link.token)).id,link.id);
  assert.equal((await resolveInvite({query},link.token,{countVisit:false})).id,link.id);
  assert.equal(await clicks(),0,'resolving with default options or explicit false must not count a visit');
  assert.equal((await request('/api/invitations/preview?token='+link.token)).status,200);
  assert.equal(await clicks(),1);
  await login(link,'click-metric@example.invalid');
  assert.equal(await clicks(),1,'OAuth verification must not inflate the preview visit count');
 });
 await test('a stale pending request cannot overwrite access granted through another invitation',async()=>{
  const email='stale-request@example.invalid',user=await member(email,'new'),stale=await invitation('owner');
  await login(stale,email);
  const item=(await list()).find(r=>r.email===email);
  await login(await invitation('viewer','single'),email);
  assert.equal((await list()).find(r=>r.id===item.id).unavailableReason,'existing_access');
  const decision=await decide(item.id,'approve');
  assert.equal(decision.status,409,'approval must enforce the same existing-access condition as the list');
  assert.equal((await membership(user)).role,'viewer');
 });
 for(const kind of ['suspended','removed'])await test('reopening the same link preserves the owner rejection for a '+kind+' member',async()=>{
  const email='rejected-'+kind+'@example.invalid',user=await member(email,kind),link=await invitation();
  await login(link,email);
  const item=(await list()).find(r=>r.email===email);
  assert.equal((await decide(item.id,'reject')).status,200);
  const before=(await rows('select status,decided_at,decided_by from agency_access_requests where id=$1',[item.id]))[0];
  assert.equal(before.status,'rejected');assert.ok(before.decided_at);assert.ok(before.decided_by);
  await login(link,email,true);
  const after=(await rows('select status,decided_at,decided_by from agency_access_requests where id=$1',[item.id]))[0];
  assert.deepEqual(after,before,'reopening a rejected link cannot erase the owner decision; a fresh link is required');
  assert.equal((await membership(user)).active,false);
  const fresh=await invitation();
  const signed=await login(fresh,email);
  assert.equal((await status(signed.cookie)).status,'pending','a fresh invitation remains reviewable');
 });
 await test('an approved request stays decided when later-suspended member reopens its link',async()=>{
  const email='approved-then-suspended@example.invalid',user=await member(email,'new'),link=await invitation();
  await login(link,email);
  const item=(await list()).find(r=>r.email===email);
  assert.equal((await decide(item.id,'approve')).status,200);
  const before=(await rows('select status,decided_at,decided_by from agency_access_requests where id=$1',[item.id]))[0];
  await query('update organization_members set active=false where organization_id=$1 and user_id=$2',[org,user]);
  await login(link,email,true);
  assert.deepEqual((await rows('select status,decided_at,decided_by from agency_access_requests where id=$1',[item.id]))[0],before);
  assert.equal((await membership(user)).active,false);
 });
 await test('unreadable ciphertext returns a null URL without exposing sealed token fields',async()=>{
  const link=await invitation();
  const listing=async()=>{
   const response=await request('/api/agency/invite-links',{cookie:ownerCookie});
   assert.equal(response.status,200);
   return response.data.links.find(r=>r.id===link.id);
  };
  assert.equal((await listing()).url,link.url,'valid ciphertext still recovers the original URL');
  for(const ciphertext of ['corrupt-ciphertext',null]){
   await query('update agency_invite_links set token_ciphertext=$1 where id=$2',[ciphertext,link.id]);
   const detail=await listing();
   assert.equal(detail.url,null,'never emit a clickable token=null URL');
   assert.equal(Object.hasOwn(detail,'token_ciphertext'),false);
   assert.equal(Object.hasOwn(detail,'token_hash'),false);
  }
 });
 await test('admin cannot recover owner invitation URL but can recover ordinary invitation URLs',async()=>{
  const user=await member('url-admin@example.invalid','active');
  await query("update organization_members set role='admin' where organization_id=$1 and user_id=$2",[org,user]);
  const adminCookie=await session(user),ownerLink=await invitation('owner'),ordinary=await invitation('editor');
  const response=await request('/api/agency/invite-links',{cookie:adminCookie});
  assert.equal(response.status,200);
  const protectedLink=response.data.links.find(r=>r.id===ownerLink.id);
  assert.equal(protectedLink.url,null);
  assert.equal(Object.hasOwn(protectedLink,'token_ciphertext'),false);
  assert.equal(Object.hasOwn(protectedLink,'token_hash'),false);
  assert.equal(JSON.stringify(response.data).includes(ownerLink.token),false);
  assert.equal(response.data.links.find(r=>r.id===ordinary.id).url,ordinary.url);
  const ownerListing=await request('/api/agency/invite-links',{cookie:ownerCookie});
  assert.equal(ownerListing.data.links.find(r=>r.id===ownerLink.id).url,ownerLink.url);
 });
 await test('approved account appears once with approval date, while direct single-use joins retain membership date',async()=>{
  const email='joined-details@example.invalid',link=await invitation();
  await login(link,email);
  const item=(await list()).find(r=>r.email===email);
  await query("update agency_access_requests set created_at=now()-interval '2 days' where id=$1",[item.id]);
  assert.equal((await decide(item.id,'approve')).status,200);
  const decision=(await rows('select created_at,decided_at from agency_access_requests where id=$1',[item.id]))[0];
  const details=(await request('/api/agency/invite-links',{cookie:ownerCookie})).data.links.find(r=>r.id===link.id);
  assert.equal(details.account_count,1);
  assert.equal(details.joined_users.filter(r=>r.email===email).length,1,'request + membership must not duplicate the same approved account');
  const joined=details.joined_users.find(r=>r.email===email);
  assert.equal(new Date(joined.joined_at).getTime(),new Date(decision.decided_at).getTime());
  assert.notEqual(new Date(joined.joined_at).getTime(),new Date(decision.created_at).getTime(),'request submission is not joining');
  const direct=await invitation('viewer','single'),directEmail='direct-join-date@example.invalid';
  await login(direct,directEmail);
  const directDetails=(await request('/api/agency/invite-links',{cookie:ownerCookie})).data.links.find(r=>r.id===direct.id);
  const directMember=(await rows('select created_at from organization_members where invite_link_id=$1',[direct.id]))[0];
  assert.equal(directDetails.joined_users.length,1);
  assert.equal(directDetails.joined_users[0].email,directEmail);
  assert.equal(new Date(directDetails.joined_users[0].joined_at).getTime(),new Date(directMember.created_at).getTime());
 });
 await test('Google never replaces a chosen personal name or photo across organizations',async()=>{
  const email='chosen-profile@example.invalid',link=await invitation('viewer','approval');
  const user=await member(email,'active');
  const first=await login(link,email);
  const saved=await request('/api/agency/productivity/profile',{cookie:first.cookie,method:'PATCH',payload:{full_name:'Nombre elegido',photo_url:'https://example.invalid/chosen.webp'}});
  assert.equal(saved.status,200);
  await login(link,email);
  const personal=(await rows('select full_name,photo_url from user_personal_identities where user_id=$1',[user]))[0];
  assert.equal(personal.full_name,'Nombre elegido');assert.equal(personal.photo_url,'https://example.invalid/chosen.webp');
 });
}finally{await pg.close();}
