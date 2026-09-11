import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {productivity} from './productivity.js';
import {suite} from './agency-suite.js';
import {ensurePersonalIdentity,ensurePersonalIdentityInTransaction} from './identity-session.js';

const pg=new PGlite();
await pg.exec("set timezone='UTC'");
const sql=async file=>pg.exec(await fs.readFile(new URL(file,import.meta.url),'utf8'));
await sql('schema.sql');
for(const file of ['20260908_treasury_ledger','20260908_google_oauth','20260908_people_commissions_comments','20260908_operations_complete','20260908_collaborator_profiles','20260908_agency_suite','20260908_daily_controls','20260910_productivity','20260910_profile_identity','20260910_demo_sessions','20260910_invite_links'])await sql(`migrations/${file}.sql`);
const query=(s,v)=>pg.query(s,v),db={connect:async()=>({query,release(){}})};
const insert=async(s,v)=>(await query(s+' returning id',v)).rows[0].id;
const org=await insert("insert into organizations(slug,name) values('identity-a','A')");
const other=await insert("insert into organizations(slug,name) values('identity-b','B')");
const template=await insert("insert into organizations(slug,name) values('scale-demo-controles-20260908','Demo')");
const uid=await insert("insert into users(email,password_hash) values('self@example.invalid','unused')");
const admin=await insert("insert into users(email,password_hash) values('admin@example.invalid','unused')");
const outsider=await insert("insert into users(email,password_hash) values('outside@example.invalid','unused')");
const guest=await insert("insert into users(email,password_hash,is_demo_guest) values('guest@example.invalid','unused',true)");
const tied=await insert("insert into users(email,password_hash) values('tie@example.invalid','unused')");
const removed=await insert("insert into users(email,password_hash) values('removed@example.invalid','unused')");
const demo=await insert("insert into organizations(slug,name,demo_owner_user_id,demo_source_id,demo_expires_at) values('identity-demo','Demo',$1,$2,now()+interval '1 day')",[uid,template]);
for(const [o,u,role] of [[org,uid,'editor'],[other,uid,'finance'],[demo,uid,'owner'],[template,uid,'owner'],[other,admin,'admin'],[other,outsider,'editor'],[template,guest,'owner']])await query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3)',[o,u,role]);
for(const [o,u,name,photo,at] of [[org,uid,'Nombre anterior','https://example.invalid/old.png','2026-09-01'],[other,uid,'Nombre reciente',null,'2026-09-09'],[demo,uid,'Nombre demo','https://example.invalid/demo.png','2026-09-10'],[template,uid,'Nombre plantilla',null,'2026-09-11'],[other,outsider,'Nombre reciente','https://example.invalid/outsider.png','2026-09-09'],[template,guest,'Invitado demo',null,'2026-09-12']])await query('insert into agency_user_profiles(organization_id,user_id,full_name,photo_url,updated_at) values($1,$2,$3,$4,$5)',[o,u,name,photo,at]);
// Profiles that merely reference an id without membership are not bootstrap candidates.
await query("insert into agency_user_profiles(organization_id,user_id,full_name,updated_at) values($1,$2,'Sin acceso',now())",[org,outsider]);
for(const u of [tied,removed])for(const o of [org,other])await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')",[o,u]);
for(const [o,u,name,at] of [[org,tied,'Empate A','2026-09-08'],[other,tied,'Empate B','2026-09-08'],[org,removed,'Nombre vigente','2026-09-01'],[other,removed,'Nombre retirado','2026-09-10']])await query('insert into agency_user_profiles(organization_id,user_id,full_name,updated_at) values($1,$2,$3,$4)',[o,u,name,at]);
await query('update organization_members set removed_at=now(),active=false where organization_id=$1 and user_id=$2',[other,removed]);
await sql('migrations/20260910_global_identity.sql');
const canonical=async u=>(await query('select * from user_personal_identities where user_id=$1',[u])).rows[0];
assert.equal((await canonical(uid)).full_name,'Nombre reciente');assert.equal((await canonical(uid)).photo_url,null);
assert.equal((await canonical(outsider)).photo_url,'https://example.invalid/outsider.png');assert.equal(await canonical(guest),undefined);
assert.equal((await canonical(tied)).full_name,'Empate A');assert.equal((await canonical(removed)).full_name,'Nombre vigente');
await sql('migrations/20260910_global_identity.sql');
assert.equal((await canonical(uid)).updated_at.toISOString(),'2026-09-09T00:00:00.000Z');
const self={id:uid,email:'self@example.invalid',organization_id:org,role:'editor'};
async function call(path='profile',method='GET',payload={},as=self){let result;await productivity({req:{method,socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://test/api/agency/productivity/'+path),db,session:async()=>as,body:async()=>payload,send:(_,status,data)=>{result={status,...data};}});return result;}
async function activity(as={...self,role:'admin'}){let result;await suite({req:{method:'GET',socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://test/api/agency/activity'),db,session:async()=>as,send:(_,status,data)=>{result={status,...data};}});return result;}
const staff=[];
for(const [o,title,salary] of [[org,'Edición',100],[other,'Finanzas',900]])staff.push(await insert("insert into agency_collaborators(organization_id,user_id,full_name,job_title,compensation_amount,email) values($1,$2,'Nombre del administrador',$3,$4,'contacto@example.invalid')",[o,uid,title,salary]));
const employment=async()=>(await query('select organization_id,job_title,job_role_id,compensation_amount,email,active from agency_collaborators where user_id=$1 order by organization_id',[uid])).rows;
const before=await employment();
const roles=(await query('select organization_id,role,active,removed_at from organization_members where user_id=$1 order by organization_id',[uid])).rows;
assert.equal((await call('profile','PATCH',{full_name:'Identidad personal',photo_url:'https://example.invalid/personal.png'})).status,200);
assert.equal((await call('profile','GET',{}, {...self,organization_id:other,role:'finance'})).profile.full_name,'Identidad personal');
assert.equal((await call('profile','GET',{}, {...self,organization_id:other,role:'finance'})).profile.role,'finance');
assert.deepEqual(await employment(),before);
assert.deepEqual((await query('select organization_id,role,active,removed_at from organization_members where user_id=$1 order by organization_id',[uid])).rows,roles);
assert((await query('select full_name,photo_url from agency_collaborators where user_id=$1',[uid])).rows.every(p=>p.full_name==='Identidad personal'&&p.photo_url==='https://example.invalid/personal.png'));
// Another company's administrator may edit HR fields, but cannot replace personal identity.
await query('begin');await query("select set_config('app.current_user',$1,true),set_config('app.current_organization',$2,true)",[String(admin),String(other)]);
await query("update agency_collaborators set full_name='Usurpado',photo_url='https://example.invalid/admin.png',job_title='Nuevo cargo',compensation_amount=950 where id=$1 and organization_id=$2",[staff[1],other]);
await assert.rejects(()=>query("update user_personal_identities set full_name='Usurpado' where user_id=$1",[uid]),/requires its owner/);await query('rollback');
await query("update agency_collaborators set full_name='Cambio local',photo_url=null,job_title='Nuevo cargo',compensation_amount=950 where id=$1 and organization_id=$2",[staff[1],other]);
assert.equal((await canonical(uid)).full_name,'Identidad personal');
assert.equal((await query('select full_name from agency_collaborators where id=$1',[staff[1]])).rows[0].full_name,'Identidad personal');
assert.equal((await employment())[1].job_title,'Nuevo cargo');assert.equal((await employment())[0].job_title,'Edición');
assert.equal((await call('profile','PATCH',{user_id:uid,full_name:'Otro'}, {...self,id:admin,organization_id:other,role:'admin'})).status,400);
assert.equal((await canonical(outsider)).full_name,'Nombre reciente'); // equal names never merge ids
assert.equal((await call('profile','PATCH',{photo_url:''})).profile.photo_url,null);
assert.equal((await call('profile','GET',{}, {...self,organization_id:other})).profile.photo_url,null);
assert.equal((await call('profile','PATCH',{full_name:'Nombre nuevo'})).profile.photo_url,null);
for(const photo of ['javascript:alert(1)','https://user:password@example.invalid/image','data:image/webp;base64,broken'])assert.equal((await call('profile','PATCH',{photo_url:photo})).status,400);
assert.equal((await call('profile','GET',{},null)).status,401);
assert.equal((await call('profile','GET',{}, {...self,id:outsider})).status,403);
assert.equal((await call('profile','PATCH',{full_name:'Sin permiso'}, {...self,id:outsider})).status,403);

// A newly entered private demo gets a snapshot, and never writes back to real identity.
const newDemo=await insert("insert into organizations(slug,name,demo_owner_user_id,demo_source_id,demo_expires_at) values('identity-demo-new','Demo',$1,$2,now()+interval '1 day')",[uid,template]);
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[newDemo,uid]);
const demoSelf={...self,organization_id:newDemo,role:'owner'};
assert.equal((await call('profile','GET',{},demoSelf)).profile.full_name,'Nombre nuevo');
assert.equal((await call('profile','PATCH',{full_name:'Mi demo',photo_url:'https://example.invalid/copy.png'},demoSelf)).profile.identity_scope,'demo');
assert.equal((await call()).profile.full_name,'Nombre nuevo');
await call('profile','PATCH',{full_name:'Real después del demo'});
assert.equal((await call('profile','GET',{},demoSelf)).profile.full_name,'Mi demo');
assert.equal((await call('profile','GET',{}, {...self,organization_id:demo})).profile.full_name,'Nombre demo');
await call('profile','PATCH',{full_name:'Plantilla editada'}, {...self,organization_id:template});
assert.equal((await canonical(uid)).full_name,'Real después del demo');
await call('profile','PATCH',{full_name:'Invitado independiente'}, {...self,id:guest,organization_id:template});
assert.equal(await canonical(guest),undefined);
await query('begin');await query("select set_config('app.current_user',$1,true),set_config('app.current_organization',$2,true)",[String(uid),String(newDemo)]);
await assert.rejects(()=>query("update user_personal_identities set full_name='Escape demo' where user_id=$1",[uid]),/requires its owner/);await query('rollback');

// Names/photos resolve through exact membership in the audit's organization.
await call('profile','PATCH',{photo_url:'https://example.invalid/final.png'});
await call('internal-tasks','POST',{title:'Actividad propia'});
await query("insert into agency_operation_audit(organization_id,table_name,action,actor,after_state) values($1,'agency_internal_tasks','INSERT',$2,'{\"title\":\"Autor ajeno\"}')",[org,String(outsider)]);
let history=await call('history','GET',{}, {...self,role:'admin'});
assert.equal(history.status,200);
assert.equal(history.records.find(r=>r.title==='Autor ajeno').actor_verified,false);
assert.equal(history.records.find(r=>r.title==='Autor ajeno').actor_photo_url,null);
assert.equal(history.records.find(r=>r.title==='Autor ajeno').actor_name,String(outsider));
assert.equal(history.records.find(r=>r.title==='Actividad propia').actor_name,'Real después del demo');
assert.equal(history.records.find(r=>r.title==='Actividad propia').actor_verified,true);
assert.equal(history.records.find(r=>r.title==='Actividad propia').actor_photo_url,'https://example.invalid/final.png');
let audit=await activity();assert.equal(audit.status,200);
const ownAudit=audit.records.find(r=>r.actor===String(uid));assert.equal(ownAudit.actor_name,'Real después del demo');assert.equal(ownAudit.actor_photo_url,'https://example.invalid/final.png');assert.equal(ownAudit.actor_verified,true);
const outsideAudit=audit.records.find(r=>r.actor===String(outsider));assert.equal(outsideAudit.actor_name,String(outsider));assert.equal(outsideAudit.actor_photo_url,null);assert.equal(outsideAudit.actor_verified,false);
const demoAudit=await activity(demoSelf);assert.equal(demoAudit.status,200);assert(demoAudit.records.filter(r=>r.actor===String(uid)).every(r=>r.actor_name==='Mi demo'&&r.actor_photo_url==='https://example.invalid/copy.png'));
assert.equal((await activity(self)).status,403);assert.equal((await activity(null)).status,401);
await call('source-events','POST',{events:[{source_key:'trello:1',source_url:'https://trello.com/c/test',source_author:'Real después del demo',body:'Importado',occurred_at:'2026-09-10'}]}, {...self,role:'admin'});
const imported=(await call('source-events')).records[0];assert.equal(imported.actor_verified,false);assert.equal(imported.actor_user_id,null);assert.equal(imported.actor_photo_url,null);
assert(!(await call('people')).people.some(p=>p.id===outsider));
await query('update organization_members set active=false where user_id=$1 and organization_id=$2',[uid,org]);
assert.equal((await call('profile','PATCH',{full_name:'Baja'})).status,403);
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'admin')",[org,admin]);
audit=await activity({...self,id:admin,role:'admin'});assert.equal(audit.status,200);
assert(audit.records.filter(r=>r.actor===String(uid)).every(r=>!r.actor_verified&&r.actor_photo_url===null&&r.actor_name===String(uid)));
history=await call('history','GET',{}, {...self,id:admin,organization_id:other,role:'admin'});
assert(!history.records.some(r=>r.title==='Actividad propia'));
await sql('migrations/20260910_global_identity.sql');
assert.equal((await canonical(uid)).full_name,'Real después del demo');

// Reactivation reconciles real profile AND HR copies, with null photos preserved.
const hrBefore=await employment();
await call('profile','PATCH',{full_name:'Identidad tras suspensión',photo_url:null},{...self,organization_id:other});
await query('update organization_members set active=true,removed_at=null where user_id=$1 and organization_id=$2',[uid,org]);
assert.deepEqual((await query('select full_name,photo_url from agency_user_profiles where user_id=$1 and organization_id=$2',[uid,org])).rows[0],{full_name:'Identidad tras suspensión',photo_url:null});
assert.deepEqual((await query('select full_name,photo_url from agency_collaborators where user_id=$1 and organization_id=$2',[uid,org])).rows[0],{full_name:'Identidad tras suspensión',photo_url:null});
assert.deepEqual(await employment(),hrBefore);
await query('update organization_members set active=false where user_id=$1 and organization_id=$2',[uid,newDemo]);
await query('update organization_members set active=true where user_id=$1 and organization_id=$2',[uid,newDemo]);
assert.deepEqual((await query('select full_name,photo_url from agency_user_profiles where user_id=$1 and organization_id=$2',[uid,newDemo])).rows[0],{full_name:'Mi demo',photo_url:'https://example.invalid/copy.png'});

// New post-migration accounts initialize during self authentication, before a save.
const fresh=await insert("insert into users(email,password_hash) values('fresh-identity@example.invalid','unused')");
for(const o of [org,other,template])await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')",[o,fresh]);
for(const [o,name,photo,at] of [[org,'Inicial A','https://example.invalid/old.png','2026-09-01'],[other,'Inicial B',null,'2026-09-09'],[template,'Demo no elegible','https://example.invalid/demo-new.png','2026-09-10']])await query('insert into agency_user_profiles(organization_id,user_id,full_name,photo_url,updated_at) values($1,$2,$3,$4,$5)',[o,fresh,name,photo,at]);
assert.deepEqual(await ensurePersonalIdentity(db,fresh,org),{full_name:'Inicial B',photo_url:null});
const initial=await canonical(fresh);
assert.deepEqual(await ensurePersonalIdentity(db,fresh,other),{full_name:'Inicial B',photo_url:null});
assert.deepEqual(await canonical(fresh),initial,'Repeated login must not update identity or its timestamp');
assert.equal((await call('profile','GET',{}, {...self,id:fresh,organization_id:org})).profile.full_name,'Inicial B');
assert.equal((await query('select full_name from agency_user_profiles where user_id=$1 and organization_id=$2',[fresh,template])).rows[0].full_name,'Demo no elegible');
const freshDemo=await insert("insert into organizations(slug,name,demo_owner_user_id,demo_expires_at) values('fresh-identity-demo','Demo',$1,now()+interval '1 day')",[fresh]);
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[freshDemo,fresh]);
assert.deepEqual((await query('select full_name,photo_url from agency_user_profiles where user_id=$1 and organization_id=$2',[fresh,freshDemo])).rows[0],{full_name:'Inicial B',photo_url:null});
assert.equal(await ensurePersonalIdentity(db,fresh,freshDemo),null);
assert.equal(await ensurePersonalIdentity(db,fresh,template),null);
assert.equal(await ensurePersonalIdentity(db,guest,template),null);
assert.equal(await ensurePersonalIdentity(db,outsider,org),null);
assert.equal(await ensurePersonalIdentity(db,removed,other),null);
const pending=await insert("insert into users(email,password_hash) values('pending-identity@example.invalid','unused')");
assert.equal(await ensurePersonalIdentity(db,pending,org),null);assert.equal(await canonical(pending),undefined);
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')",[org,pending]);
assert.deepEqual(await ensurePersonalIdentity(db,pending,org),{full_name:'pending-identity@example.invalid',photo_url:null});
// Guest accounts stay excluded even if an unexpected real membership exists.
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')",[org,guest]);
assert.equal(await ensurePersonalIdentity(db,guest,org),null);assert.equal(await canonical(guest),undefined);

// Embedded helper preserves caller audit context and honors caller rollback.
const rollbackUser=await insert("insert into users(email,password_hash) values('rollback-identity@example.invalid','unused')");
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')",[org,rollbackUser]);
await query('begin');await query("select set_config('app.current_user','caller-audit',true),set_config('app.current_organization','caller-org',true)");
assert.deepEqual(await ensurePersonalIdentityInTransaction({query},rollbackUser,org),{full_name:'rollback-identity@example.invalid',photo_url:null});
assert.deepEqual((await query("select current_setting('app.current_user',true) as actor,current_setting('app.current_organization',true) as org")).rows[0],{actor:'caller-audit',org:'caller-org'});
await query('rollback');assert.equal(await canonical(rollbackUser),undefined);
let released=0,rollback=0;
const failingDb={connect:async()=>({query:async s=>{if(s==='rollback'){rollback++;return {rows:[]};}if(s==='begin')return {rows:[]};throw Error('identity failure');},release(){released++;}})};
await assert.rejects(()=>ensurePersonalIdentity(failingDb,uid,org),/identity failure/);assert.equal(rollback,1);assert.equal(released,1);
await assert.rejects(()=>ensurePersonalIdentity(db,'1 OR 1=1',org),/Invalid identity id/);
// Current behavior: real owners use live personal identity even in existing demos.
await sql('migrations/20260911_demo_owner_identity.sql');
const shared=await call('profile','GET',{},demoSelf);
assert.equal(shared.profile.identity_scope,'personal_readonly');
assert.equal(shared.profile.full_name,(await canonical(uid)).full_name);
assert.equal(shared.profile.photo_url,(await canonical(uid)).photo_url);
assert.equal((await call('profile','PATCH',{full_name:'No debe cambiar'},demoSelf)).status,403);
await call('profile','PATCH',{full_name:'Unificado en todas',photo_url:'https://example.invalid/unified.png'});
for(const organization_id of [org,other,newDemo,demo]){
 const p=(await call('profile','GET',{}, {...self,organization_id})).profile;
 assert.equal(p.full_name,'Unificado en todas');assert.equal(p.photo_url,'https://example.invalid/unified.png');
}
assert.equal((await call('profile','GET',{}, {...self,id:guest,organization_id:template})).profile.full_name,'Invitado independiente');
// Startup replays both migrations safely, without dropping view columns or changing users.
await sql('migrations/20260910_global_identity.sql');await sql('migrations/20260911_demo_owner_identity.sql');
assert.equal((await call('profile','GET',{},demoSelf)).profile.full_name,'Unificado en todas');
await pg.close();
console.log('PASS: deterministic identity, self propagation, scoped roles/HR/authors, demo isolation, reactivation reconciliation, session initialization/idempotency/fallback, pending/guest guards, transaction rollback');
