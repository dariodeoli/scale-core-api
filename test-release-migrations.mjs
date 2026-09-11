import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {productivity} from './productivity.js';
import {projectAssignees} from './project-assignees.js';
import {ensurePersonalIdentity} from './identity-session.js';

// Read the release's actual registration order, not a second hand-maintained list.
// Optional Dadoo belongs to another product and is explicitly excluded.
const read=file=>fs.readFile(new URL(file,import.meta.url),'utf8');
const server=await read('server.js');
const start=server.indexOf('async function init()');
const end=server.indexOf("await migration.query('commit')",start);
assert(start>=0&&end>start,'Server migration transaction must be identifiable');
const files=[...server.slice(start,end).matchAll(/(2026\d{4}_[a-z0-9_]+\.sql)/g)].map(m=>m[1]).filter(f=>f!=='20260908_dadoo_hub.sql');
assert.equal(files.length,new Set(files).size,'Unexpected duplicate migration registration');
for(const required of ['20260910_global_identity.sql','20260910_company_currency.sql','20260910_project_assignees.sql','20260910_inventory_reservations.sql','20260910_work_checklists.sql'])assert(files.includes(required),`${required} missing from server init`);
const pg=new PGlite();
const query=(s,v)=>pg.query(s,v),db={connect:async()=>({query,release(){}})};
const insert=async(s,v)=>(await query(s+' returning id',v)).rows[0].id;
async function migrate(){
 await pg.exec('begin');let current='schema.sql';
 try{await pg.exec(await read(current));for(const file of files){current='migrations/'+file;await pg.exec(await read(current));}await pg.exec('commit');}
 catch(error){await pg.exec('rollback');throw Error(`Release migration ${current}: ${error.code||''} ${error.message}`,{cause:error});}
}
async function call(handler,path,as,method='GET',payload={},expectedStatus=200){
 let response;const handled=await handler({req:{method,socket:{remoteAddress:'release-fixture'}},res:{},url:new URL('https://test/api/agency/'+path),db,session:async()=>as,body:async()=>payload,send:(_,status,data)=>{response={status,...data};}});
 assert.equal(handled,true);assert.equal(response.status,expectedStatus,JSON.stringify(response));return response;
}
try{
 await migrate();
 const a=await insert("insert into organizations(slug,name) values('release-a','Release A')");
 const b=await insert("insert into organizations(slug,name) values('release-b','Release B')");
 const uid=await insert("insert into users(email,password_hash) values('release@example.invalid','unused')");
 const guest=await insert("insert into users(email,password_hash,is_demo_guest) values('release-guest@example.invalid','unused',true)");
 await query("insert into organization_members(organization_id,user_id,role) values($1,$3,'owner'),($2,$3,'editor')",[a,b,uid]);
 const self={id:uid,email:'release@example.invalid',organization_id:a,role:'owner'},other={...self,organization_id:b,role:'editor'};
 await query("insert into agency_user_profiles(organization_id,user_id,full_name,photo_url) values($1,$2,'Identidad release','https://example.invalid/release.png')",[a,uid]);
 assert.deepEqual(await ensurePersonalIdentity(db,uid,a),{full_name:'Identidad release',photo_url:'https://example.invalid/release.png'});
 const peer=(await call(productivity,'productivity/profile',other)).profile;
 assert.equal(peer.full_name,'Identidad release');assert.equal(peer.photo_url,'https://example.invalid/release.png');assert.equal(peer.role,'editor');
 const demo=await insert("insert into organizations(slug,name,demo_owner_user_id,demo_expires_at) values('release-private-demo','Demo',$1,now()+interval '1 day')",[uid]);
 const publicDemo=await insert("insert into organizations(slug,name,demo_owner_user_id,demo_expires_at) values('release-public-demo','Public Demo',$1,now()+interval '1 day')",[guest]);
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",[demo,uid,publicDemo,guest]);
 const demoSelf={...self,organization_id:demo};
 assert.equal((await call(productivity,'productivity/profile',demoSelf)).profile.full_name,'Identidad release');
 assert.equal((await call(productivity,'productivity/profile',demoSelf)).profile.identity_scope,'personal_readonly');
 await call(productivity,'productivity/profile',demoSelf,'PATCH',{full_name:'Copia demo',photo_url:'https://example.invalid/demo.png'},403);
 await call(productivity,'productivity/profile',{...self,id:guest,organization_id:publicDemo},'PATCH',{full_name:'Invitado independiente'});
 assert.equal((await call(productivity,'productivity/profile',self)).profile.full_name,'Identidad release');
 assert.equal((await query('select count(*)::int as n from user_personal_identities where user_id=$1',[guest])).rows[0].n,0);
 const client=await insert("insert into agency_clients(organization_id,name) values($1,'Release client')",[a]);
 const project=await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Release project')",[a,client]);
 const order=await insert("insert into agency_work_orders(organization_id,project_id,title) values($1,$2,'Release order')",[a,project]);
 const assigned=await call(projectAssignees,`work-orders/${order}/assignees`,self,'PATCH',{assigned_user_ids:[String(uid)],expected_version:'0'});
 assert.deepEqual(assigned.assigned_user_ids,[String(uid)]);
 for(const relation of ['organization_person_identity','agency_record_assignees','agency_project_assignees','agency_work_order_assignees','agency_inventory_categories','agency_inventory_reservations','agency_inventory_reservation_members','agency_inventory_reservation_items','agency_work_checklists','agency_work_checklist_items']){
  assert.equal((await query('select to_regclass($1)::text as name',[relation])).rows[0].name,relation,`Missing release relation ${relation}`);
 }
 // Re-run the exact server transaction with populated identities and assignments.
 await migrate();
 assert.equal((await call(productivity,'productivity/profile',other)).profile.full_name,'Identidad release');
 assert.equal((await call(productivity,'productivity/profile',demoSelf)).profile.full_name,'Identidad release');
 assert.equal((await call(productivity,'productivity/profile',demoSelf)).profile.photo_url,'https://example.invalid/release.png');
 assert.deepEqual((await call(projectAssignees,`work-orders/${order}/assignees`,self)).assigned_user_ids,[String(uid)]);
 await query("insert into agency_collaborators(organization_id,user_id,full_name,job_title,compensation_amount) values($1,$2,'Identidad release','Editor',100)",[a,uid]);
 await query('update organization_members set active=false where organization_id=$1 and user_id=$2',[a,uid]);
 await call(productivity,'productivity/profile',other,'PATCH',{full_name:'Actualizado desde B',photo_url:''});
 await query('update organization_members set active=true where organization_id=$1 and user_id=$2',[a,uid]);
 assert.deepEqual((await query('select full_name,photo_url from agency_user_profiles where organization_id=$1 and user_id=$2',[a,uid])).rows[0],{full_name:'Actualizado desde B',photo_url:null});
 const hr=(await query('select full_name,photo_url,job_title,compensation_amount from agency_collaborators where organization_id=$1 and user_id=$2',[a,uid])).rows[0];
 assert.equal(hr.full_name,'Actualizado desde B');assert.equal(hr.photo_url,null);assert.equal(hr.job_title,'Editor');assert.equal(Number(hr.compensation_amount),100);
 assert.deepEqual(await ensurePersonalIdentity(db,uid,a),{full_name:'Actualizado desde B',photo_url:null});
 assert.equal((await call(productivity,'productivity/profile',self)).profile.full_name,'Actualizado desde B');
 assert.equal((await call(productivity,'productivity/profile',self)).profile.photo_url,null);
 assert.equal((await call(productivity,'productivity/profile',demoSelf)).profile.full_name,'Actualizado desde B');
 assert.equal((await call(productivity,'productivity/profile',demoSelf)).profile.photo_url,null);
 assert.equal((await query('select role from organization_members where organization_id=$1 and user_id=$2',[b,uid])).rows[0].role,'editor');
 console.log(`PASS: schema + ${files.length} server-registered migrations twice, session identity initialization, real reactivation/HR sync, demo isolation, assignee flow, inventory/checklist relations; optional Dadoo excluded`);
}catch(error){console.error(error.stack||error);process.exitCode=1;}
finally{await pg.close();}
