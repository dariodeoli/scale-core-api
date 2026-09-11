// Run with node --experimental-vm-modules test-auth.mjs.
// Uses a temporary embedded PostgreSQL database; never contacts Google or production.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
await db.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
for(const f of ['20260908_treasury_ledger.sql','20260908_google_oauth.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_agency_suite.sql'])await db.exec(await fs.readFile(new URL(`./migrations/${f}`,import.meta.url),'utf8'));
for(const f of ['20260908_daily_controls.sql','20260910_productivity.sql','20260910_profile_identity.sql','20260910_demo_sessions.sql','20260910_notifications.sql','20260910_client_links.sql','20260910_invite_links.sql','20260910_currencies.sql'])await db.exec(await fs.readFile(new URL(`./migrations/${f}`,import.meta.url),'utf8'));
for(const f of ['20260910_company_currency.sql','20260910_global_identity.sql','20260910_project_assignees.sql','20260910_inventory_reservations.sql','20260910_work_checklists.sql'])await db.exec(await fs.readFile(new URL(`./migrations/${f}`,import.meta.url),'utf8'));
const query=(s,v)=>db.query(s,v);
await db.exec(await fs.readFile(new URL('./migrations/20260911_default_login_organization.sql',import.meta.url),'utf8'));
await db.exec(await fs.readFile(new URL('./migrations/20260911_google_profile_photo.sql',import.meta.url),'utf8'));
for(const f of ['20260911_subscriptions.sql','20260911_trial_registration.sql'])await db.exec(await fs.readFile(new URL(`./migrations/${f}`,import.meta.url),'utf8'));
for(const f of ['20260910_client_lifecycle.sql','20260911_agency_reports.sql','20260911_invite_link_metrics.sql','20260911_invite_link_details.sql'])await db.exec(await fs.readFile(new URL(`./migrations/${f}`,import.meta.url),'utf8'));
const org=(await query("insert into organizations(slug,name) values('other','Another agency') returning id")).rows[0].id;
const scale=(await query("select id from organizations where slug='scale'")).rows[0].id;
const uid=(await query("insert into users(email,password_hash) values('member@example.invalid','unused') returning id")).rows[0].id;
await query("insert into organization_members values($1,$2,'editor',now())",[org,uid]);
let handler,profile={email:'member@example.invalid',email_verified:true};
const context=vm.createContext({console,URL,URLSearchParams,Buffer,fetch:async url=>({ok:true,json:async()=>url.includes('/token')?{access_token:'mock'}:profile}),process:{env:{GOOGLE_CLIENT_ID:'mock',GOOGLE_CLIENT_SECRET:'mock'}},setTimeout,clearTimeout});
const module=new vm.SourceTextModule(await fs.readFile(new URL('./server.js',import.meta.url),'utf8'),{context,identifier:new URL('./server.js',import.meta.url).href,initializeImportMeta(meta){meta.url=new URL('./server.js',import.meta.url).href;}});
await module.link(async spec=>{
 let exports;
 if(spec==='node:http')exports={default:{createServer:fn=>{handler=fn;return{listen(){}};}}};
 else if(spec==='pg')exports={default:{Pool:class{query=query;connect=async()=>({query,release(){}});}}};
 else if(spec==='./operations.js')exports={operations:async()=>false};
 else exports=await import(spec);
 const keys=Object.keys(exports);return new vm.SyntheticModule(keys,function(){keys.forEach(k=>this.setExport(k,exports[k]));},{context});
});
await module.evaluate();
async function request(path,{method='GET',cookie='',payload}={}){
 const result={status:0,headers:{},body:''};const req={url:path,method,headers:{host:'admin.scaleparaguay.com',cookie},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){if(payload)yield JSON.stringify(payload);}};
 await handler(req,{setHeader(k,v){result.headers[k]=v;},writeHead(s,h){result.status=s;Object.assign(result.headers,h);},end(b){result.body=b||'';}});return result;
}
async function callback(invite=''){const start=await request('/api/auth/google/start'+(invite?'?invite='+invite:''));assert.equal(start.status,302);const state=new URL(start.headers.Location).searchParams.get('state');const cookie=start.headers['Set-Cookie'].split(';')[0];return request(`/api/auth/google/callback?state=${state}&code=mock`,{cookie});}
let r=await request('/api/auth/google/callback?state=forged&code=mock');assert.equal(r.status,302);assert.ok(r.headers.Location.includes('authError'));
r=await callback();assert.equal(r.status,302);assert.ok(r.headers.Location.startsWith('https://app.scaleparaguay.com/core-api/api/auth/google/complete?ticket='));
const complete=new URL(r.headers.Location);r=await request(complete.pathname.replace('/core-api','')+complete.search);assert.equal(r.status,302);const cookie=r.headers['Set-Cookie'].split(';')[0];
assert.equal((await request(complete.pathname.replace('/core-api','')+complete.search)).headers['Set-Cookie'],undefined);
r=await request('/api/auth/me',{cookie});assert.equal(r.status,200);assert.equal(JSON.parse(r.body).user.organization_slug,'other');
assert.equal(JSON.parse(r.body).user.default_currency,'PYG');
assert.equal(JSON.parse(r.body).user.full_name,'member@example.invalid','First authenticated request initializes the own-email fallback');
assert.equal(Object.hasOwn(JSON.parse(r.body).user,'has_personal_identity'),false);
assert.equal((await query('select full_name from user_personal_identities where user_id=$1',[uid])).rows[0].full_name,'member@example.invalid');
r=await request('/api/agency/productivity/profile',{cookie,method:'PATCH',payload:{full_name:'Mi identidad global',photo_url:'https://example.invalid/personal.png'}});assert.equal(r.status,200);
r=await request('/api/auth/me',{cookie});assert.equal(JSON.parse(r.body).user.full_name,'Mi identidad global');assert.equal(JSON.parse(r.body).user.photo_url,'https://example.invalid/personal.png');
r=await request('/api/auth/organizations',{cookie});assert.equal(JSON.parse(r.body).organizations.length,1);
r=await request('/api/auth/switch-organization',{cookie,method:'POST',payload:{organizationId:scale}});assert.equal(r.status,403);
await query("insert into organization_members values($1,$2,'viewer',now())",[scale,uid]);
await query("insert into agency_settings(organization_id,default_currency) values($1,'USD') on conflict(organization_id) do update set default_currency='USD'",[scale]);
r=await request('/api/auth/organizations',{cookie});assert.equal(JSON.parse(r.body).organizations.length,2);
r=await request('/api/auth/switch-organization',{cookie,method:'POST',payload:{organizationId:scale}});assert.equal(r.status,200);const switched=r.headers['Set-Cookie'].split(';')[0];
r=await request('/api/auth/me',{cookie:switched});assert.equal(JSON.parse(r.body).user.role,'viewer');assert.equal(JSON.parse(r.body).user.organization_slug,'scale');
assert.equal(JSON.parse(r.body).user.full_name,'Mi identidad global');assert.equal(JSON.parse(r.body).user.photo_url,'https://example.invalid/personal.png');assert.equal(JSON.parse(r.body).user.default_currency,'USD');
profile={email:'uninvited@example.invalid',email_verified:true};r=await callback();assert.ok(r.headers.Location.includes('authError'));assert.equal(r.headers['Set-Cookie'],undefined);
await query('update organization_members set active=false where user_id=$1',[uid]);profile={email:'member@example.invalid',email_verified:true};r=await callback();assert.ok(r.headers.Location.includes('authError'));assert.equal((await request('/api/auth/me',{cookie:switched})).status,401);
const owner=(await query("insert into users(email,password_hash) values('reinvitations-owner@example.invalid','unused') returning id")).rows[0].id;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[scale,owner]);
await query("insert into sessions(id,user_id,organization_id,expires_at) values('owner-test-session',$1,$2,now()+interval '1 day')",[owner,scale]);
const ownerCookie='scale_session=owner-test-session';
r=await request(`/api/agency/members/${uid}`,{cookie:ownerCookie,method:'DELETE'});assert.equal(r.status,200);
r=await request('/api/agency/members',{cookie:ownerCookie});assert.ok(!JSON.parse(r.body).members.some(m=>m.id===uid));
r=await request('/api/agency/members',{cookie:ownerCookie,method:'POST',payload:{email:'member@example.invalid',role:'editor'}});assert.equal(r.status,201);assert.equal(JSON.parse(r.body).emailSent,false);
const reinstated=(await query('select active,removed_at,role from organization_members where organization_id=$1 and user_id=$2',[scale,uid])).rows[0];assert.deepEqual(reinstated,{active:true,removed_at:null,role:'editor'});
r=await request('/api/agency/members',{cookie:ownerCookie,method:'POST',payload:{email:'member@example.invalid',role:'owner'}});assert.equal(r.status,409);
const client=(await query("insert into agency_clients(organization_id,name) values($1,'Archive Integration') returning id",[scale])).rows[0].id;
const project=(await query("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Child Project') returning id",[scale,client])).rows[0].id;
const order=(await query("insert into agency_work_orders(organization_id,project_id,title) values($1,$2,'Child Order') returning id",[scale,project])).rows[0].id;
// Exercise the integrated endpoint and orders view through the real HTTP handler.
r=await request(`/api/agency/work-orders/${order}/assignees`,{cookie:ownerCookie,method:'PATCH',payload:{assigned_user_ids:[String(owner)],assigned_user_id:String(owner),expected_version:'0'}});assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.body).assigned_user_ids,[String(owner)]);
r=await request('/api/agency/work-orders',{cookie:ownerCookie});assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.body).workOrders.find(row=>row.id===order).assigned_user_ids,[String(owner)]);
assert.equal((await request(`/api/agency/work-orders/${order}/assignees`)).status,401);
r=await request('/api/agency/clients',{cookie:ownerCookie});assert.equal(JSON.parse(r.body).clients.length,1);
assert.equal((await request(`/api/agency/clients/${client}`,{cookie:ownerCookie,method:'DELETE'})).status,200);
for(const [path,key] of [['clients','clients'],['projects','projects'],['work-orders','workOrders']]){r=await request('/api/agency/'+path,{cookie:ownerCookie});assert.equal(r.status,200);assert.equal(JSON.parse(r.body)[key].length,0);}
r=await request('/api/agency/summary',{cookie:ownerCookie});assert.deepEqual(JSON.parse(r.body).summary,{active_clients:0,active_projects:0,open_orders:0});
assert.equal((await request(`/api/agency/clients/${client}/restore`,{cookie:ownerCookie,method:'POST'})).status,200);
r=await request('/api/agency/projects',{cookie:ownerCookie});assert.equal(JSON.parse(r.body).projects[0].work_order_count,1);
// Pending applicants can see only the waiting screen, never agency data.
r=await request('/api/agency/invite-links',{cookie:ownerCookie,method:'POST',payload:{role:'editor',mode:'approval'}});assert.equal(r.status,200);
const inviteToken=new URL(JSON.parse(r.body).url).searchParams.get('token');
profile={email:'pending@example.invalid',name:'Pending Test',email_verified:true};r=await callback(inviteToken);assert.equal(r.status,302);
const pendingComplete=new URL(r.headers.Location);r=await request(pendingComplete.pathname.replace('/core-api','')+pendingComplete.search);assert(r.headers.Location.endsWith('/acceso-pendiente'));
const pendingCookie=r.headers['Set-Cookie'].split(';')[0];
assert.equal((await request('/api/auth/me',{cookie:pendingCookie})).status,401);
assert.equal((await request('/api/agency/clients',{cookie:pendingCookie})).status,401);
assert.equal((await request('/api/agency/work-orders',{cookie:pendingCookie})).status,401);
assert.equal(JSON.parse((await request('/api/invitations/status',{cookie:pendingCookie})).body).status,'pending');
const pendingRows=JSON.parse((await request('/api/agency/access-requests',{cookie:ownerCookie})).body).requests;
assert.equal((await request('/api/agency/access-requests/'+pendingRows[0].id,{cookie:ownerCookie,method:'PATCH',payload:{action:'approve'}})).status,200);
assert.equal(JSON.parse((await request('/api/invitations/status',{cookie:pendingCookie})).body).status,'approved');
assert.equal(JSON.parse((await request('/api/auth/me',{cookie:pendingCookie})).body).user.role,'editor');
const approvedIdentity=JSON.parse((await request('/api/auth/me',{cookie:pendingCookie})).body).user;
assert.equal(approvedIdentity.full_name,'Pending Test');assert.equal(Object.hasOwn(approvedIdentity,'has_personal_identity'),false);
assert.equal((await request('/api/agency/clients',{cookie:pendingCookie})).status,200);
assert.equal((await request('/api/agency/accounts',{cookie:pendingCookie})).status,403);
await db.close();console.log('PASS: Google state/membership, single-use handoff, multiagency roles, revocation, explicit reinvitation, no outbound emails, operational archive lists/summary/restore');
