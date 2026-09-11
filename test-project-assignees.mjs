import assert from 'node:assert/strict';
import {identitySchema} from './scripts/test-identity-schema.mjs';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {projectAssignees,getRecordAssignees,setRecordAssignees,normalizeAssigneeIds} from './project-assignees.js';
import {suite} from './agency-suite.js';

const pg=new PGlite();
const load=async file=>pg.exec(await fs.readFile(new URL(file,import.meta.url),'utf8'));
await load('schema.sql');
for(const name of ['20260908_treasury_ledger','20260908_people_commissions_comments','20260908_operations_complete','20260908_referral_discounts','20260908_collaborator_profiles','20260908_agency_suite','20260908_daily_controls','20260910_productivity'])await load(`migrations/${name}.sql`);
await identitySchema(pg);
const query=(sql,values)=>pg.query(sql,values),db={query,connect:async()=>({query,release(){}})};
const insert=async(sql,values)=>String((await query(sql+' returning id',values)).rows[0].id);
const org=String((await query("select id from organizations where slug='scale'")).rows[0].id);
const other=await insert("insert into organizations(slug,name) values('assignees-other','Other')");
const people={};
for(const role of ['owner','admin','management','production','editor','viewer','finance','sales']){
 const id=await insert("insert into users(email,password_hash) values($1,'unused')",[role+'@assignees.example.invalid']);
 await query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3)',[org,id,role]);
 people[role]={id,organization_id:org,role};
}
const user=people.owner;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[other,user.id]);
const outsider=await insert("insert into users(email,password_hash) values('other@assignees.example.invalid','unused')");
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'editor')",[other,outsider]);
const client=await insert("insert into agency_clients(organization_id,name) values($1,'Client')",[org]);
const project=await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Project')",[org,client]);
const order=await insert("insert into agency_work_orders(organization_id,project_id,title,assigned_user_id) values($1,$2,'Order',$3)",[org,project,people.editor.id]);
const foreignClient=await insert("insert into agency_clients(organization_id,name) values($1,'Foreign')",[other]);
const foreignProject=await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Foreign')",[other,foreignClient]);
const migration='migrations/20260910_project_assignees.sql';await load(migration);await load(migration);
const orderPath=`/api/agency/work-orders/${order}/assignees`,projectPath=`/api/agency/projects/${project}/assignees`;
async function call(path,method='GET',payload={},as=user){
 let response;
 const handled=await projectAssignees({req:{method,socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://test'+path),db,session:async()=>as,body:async()=>payload,send:(_,status,data)=>{response={status,...data};}});
 return handled?response:false;
}
async function save(path,ids,primary,as=user){const state=await call(path);return call(path,'PATCH',{assigned_user_ids:ids,assigned_user_id:primary,expected_version:state.assignee_version},as);}
assert.equal(await call('/api/agency/projects'),false);
assert.equal((await call(orderPath,'GET',{},null)).status,401);
assert.equal((await call(orderPath,'POST')).status,405);
assert.equal((await call('/api/agency/assignees','PATCH')).status,405);
assert.equal((await call(`/api/agency/projects/${foreignProject}/assignees`)).status,404);
assert.equal((await call(orderPath,'GET',{}, {...user,organization_id:other})).status,404);
assert.deepEqual(normalizeAssigneeIds(['001',1,2,'2']),['1','2']);
for(const ids of [null,{},'1',[0],['-1'],[true],['1e2'],['1.2'],[Number.MAX_SAFE_INTEGER+1],['9223372036854775808'],Array(101).fill('1')])assert.throws(()=>normalizeAssigneeIds(ids));
let r=await call(orderPath);assert.deepEqual(r.assigned_user_ids,[people.editor.id]);assert.equal(r.assignee_version,'0');
const membersBefore=(await query('select * from organization_members order by organization_id,user_id')).rows;
for(const kind of [projectPath,orderPath]){
 r=await save(kind,[people.editor.id,people.viewer.id,'00'+people.editor.id],people.editor.id);
 assert.equal(r.status,200);assert.equal(r.assigned_user_ids.length,2);assert.equal(r.assigned_user_id,people.editor.id);
 const version=r.assignee_version;
 assert.equal((await save(kind,[people.viewer.id,people.editor.id],people.editor.id)).assignee_version,version,'same selection is idempotent');
 assert.equal((await call(kind,'PATCH',{assigned_user_ids:[],expected_version:'0'})).status,409,'stale edit rejected');
 assert.equal((await call(kind,'PATCH',{assigned_user_ids:[],expected_version:version,role:'owner'})).status,400);
 assert.equal((await call(kind,'PATCH',{assigned_user_ids:[]})).status,400,'version required');
 assert.equal((await save(kind,[outsider],outsider)).status,400);
 assert.equal((await save(kind,[people.viewer.id],people.editor.id)).status,400);
 assert.equal((await save(kind,[people.viewer.id],null)).status,400);
 for(const role of ['viewer','finance','sales'])assert.equal((await save(kind,[],null,people[role])).status,403);
 for(const role of ['owner','admin','management','production'])assert.equal((await save(kind,[people.editor.id,people.viewer.id],people.editor.id,people[role])).status,200);
}
assert.equal((await save(projectPath,[],null,people.editor)).status,403);
assert.equal((await save(orderPath,[people.viewer.id],people.viewer.id,people.editor)).status,200);
assert.deepEqual((await query('select * from organization_members order by organization_id,user_id')).rows,membersBefore,'assignment never changes access or role');
assert.equal((await save(orderPath,[],null,{...people.viewer,role:'owner'})).status,403,'database role defeats a stale or forged elevated session');
assert.equal((await save(orderPath,[],null,{...user,role:'viewer'})).status,403,'session role also restricts access');
await query('update organization_members set active=false where organization_id=$1 and user_id=$2',[org,people.viewer.id]);
assert.equal((await save(orderPath,[people.viewer.id],people.viewer.id)).status,400);
assert.equal((await call(orderPath,'GET',{},people.viewer)).status,403);
assert.ok(!(await call('/api/agency/assignees')).members.some(m=>[outsider,people.viewer.id].includes(m.id)));
assert.ok(!(await call(projectPath)).assigned_user_ids.includes(people.viewer.id),'inactive secondary filtered');
assert.equal((await save(orderPath,[],null)).status,200);
assert.equal((await query('select assigned_user_id from agency_work_orders where id=$1',[order])).rows[0].assigned_user_id,null,'clearing also removes an inactive legacy primary');
await query('update organization_members set active=true,removed_at=now() where organization_id=$1 and user_id=$2',[org,people.viewer.id]);
assert.equal((await save(orderPath,[people.viewer.id],people.viewer.id)).status,400,'removed members rejected even if active flag is true');
await assert.rejects(()=>query('insert into agency_work_order_assignees(organization_id,work_order_id,user_id) values($1,$2,$3)',[org,order,outsider]));
await assert.rejects(()=>query('insert into agency_project_assignees(organization_id,project_id,user_id) values($1,$2,$3)',[org,foreignProject,people.editor.id]));
await assert.rejects(()=>query('update agency_work_orders set assigned_user_id=$1 where id=$2',[outsider,order]));
await query('update organization_members set removed_at=null where organization_id=$1 and user_id=$2',[org,people.viewer.id]);
await save(orderPath,[people.editor.id,people.viewer.id],people.editor.id);
const previous=await call(orderPath);
await query('update agency_work_orders set assigned_user_id=$1 where id=$2',[people.production.id,order]);
r=await call(orderPath);assert.equal(r.assignee_version,String(BigInt(previous.assignee_version)+1n));
assert.deepEqual(new Set(r.assigned_user_ids),new Set([people.production.id,people.viewer.id]),'legacy primary update preserves supplementary assignees');
assert.equal((await call(orderPath,'PATCH',{assigned_user_ids:[],expected_version:previous.assignee_version})).status,409);
await query('update agency_work_orders set assigned_user_id=$1 where id=$2',[people.viewer.id,order]);
assert.deepEqual((await call(orderPath)).assigned_user_ids,[people.viewer.id],'primary and supplementary overlap is deduplicated');
await load(migration);assert.deepEqual((await call(orderPath)).assigned_user_ids,[people.viewer.id],'migration repeat preserves assignments');
await query('begin');
await setRecordAssignees({query},user,'projects',project,{assigned_user_ids:[],expected_version:(await getRecordAssignees({query},user,'projects',project)).assignee_version});
await query('rollback');assert.ok((await call(projectPath)).assigned_user_ids.length,'helper obeys caller rollback');
for(const [kind,key] of [['clients',client],['projects',project],['work-orders',order]]){
 await query('insert into agency_archived_records(organization_id,kind,record_id) values($1,$2,$3)',[org,kind,key]);
 assert.equal((await call(orderPath)).status,409,'archived parent chain rejected: '+kind);
 await query('delete from agency_archived_records where organization_id=$1 and kind=$2 and record_id=$3',[org,kind,key]);
}
await query('update organizations set active=false where id=$1',[org]);assert.equal((await call(orderPath)).status,403);
await query('update organizations set active=true where id=$1',[org]);
assert.ok((await query("select 1 from agency_operation_audit where table_name='agency_work_order_assignees' and actor=$1",[user.id])).rows.length,'supplementary changes are audited');
// Exercise the actual detail endpoint: assignment validation must roll back details too.
await load('migrations/20260911_drive_links.sql');
async function detail(kind,key,payload,as=user){
 let response;
 await suite({req:{method:'PATCH',socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL(`https://test/api/agency/${kind}/${key}`),db,session:async()=>as,body:async()=>payload,send:(_,status,data)=>{response={status,...data};}});
 return response;
}
for(const [kind,key,field] of [['projects',project,'name'],['work-orders',order,'title']]){
 const table=kind==='projects'?'agency_projects':'agency_work_orders';
 const read=async()=>(await query(`select * from ${table} where id=$1`,[key])).rows[0];
 const before=await read(),snapshot=await call(`/api/agency/${kind}/${key}/assignees`);
 const payload={[field]:'Unified update',expected_updated_at:before.updated_at,assignees:{assigned_user_ids:[people.editor.id],assigned_user_id:people.editor.id,expected_version:snapshot.assignee_version}};
 assert.equal((await detail(kind,key,{...payload,assignees:{...payload.assignees,expected_version:'999999'}})).status,409);
 assert.deepEqual(await read(),before,'assignment conflict rolls back all detail fields');
 assert.equal((await detail(kind,key,{...payload,assignees:{...payload.assignees,assigned_user_ids:[outsider],assigned_user_id:outsider}})).status,400);
 assert.deepEqual(await read(),before,'invalid membership rolls back details');
 assert.equal((await detail(kind,key,{...payload,expected_updated_at:'2000-01-01T00:00:00Z'})).status,409);
 assert.equal((await detail(kind,key,payload,people.viewer)).status,403);
 assert.equal((await detail(kind,key,{...payload,assigned_user_id:people.editor.id})).status,400,'mixed legacy and unified assignments rejected');
 assert.equal((await detail(kind,key,{...payload,[field]:'x'})).status,400);
 assert.deepEqual((await call(`/api/agency/${kind}/${key}/assignees`)).assigned_user_ids,snapshot.assigned_user_ids,'invalid details preserve assignments');
 const saved=await detail(kind,key,payload);
 assert.equal(saved.status,200);assert.equal(saved.record[field],'Unified update');
 assert.deepEqual(saved.assignees.assigned_user_ids,[people.editor.id]);
 assert.equal(String(saved.record.assignee_version),saved.assignees.assignee_version,'response includes the final version');
 assert.equal((await detail(kind,key,payload)).status,409,'replay cannot overwrite newer details');
}
const oldPrimary=(await query('select assigned_user_id from agency_work_orders where id=$1',[order])).rows[0].assigned_user_id;
await query('update organization_members set active=false where organization_id=$1 and user_id=$2',[org,oldPrimary]);
const inactiveOrder=(await query('select * from agency_work_orders where id=$1',[order])).rows[0];
assert.equal((await detail('work-orders',order,{title:'Replace inactive primary',expected_updated_at:inactiveOrder.updated_at,assignees:{assigned_user_ids:[user.id],assigned_user_id:user.id,expected_version:String(inactiveOrder.assignee_version)}})).status,200,'unified edit can remove inactive legacy primary');
// Run the real list query with the production identity view and a foreign project.
const server=await fs.readFile(new URL('server.js',import.meta.url),'utf8');
const listSQL=server.match(/const r=await db.query\(`(select p\.\*,c\.name as client_name[^`]+)`/)[1].replaceAll("${visibleRecord('o','work-orders')}",'true').replaceAll("${visibleRecord('p','projects')}",'true').replaceAll("${visibleRecord('c','clients')}",'true');
const listed=(await query(listSQL,[org])).rows;
assert.ok(listed.every(row=>String(row.organization_id)===org),'project directory remains tenant scoped');
assert.ok(!listed.some(row=>String(row.id)===foreignProject));
assert.deepEqual(listed.find(row=>String(row.id)===project).assignees,[],'inactive assignments do not leak through directory');
await query('update organization_members set active=true where organization_id=$1 and user_id=$2',[org,oldPrimary]);
const listedPerson=(await query(listSQL,[org])).rows.find(row=>String(row.id)===project).assignees[0];
assert.equal(listedPerson.id,people.editor.id);assert.equal(listedPerson.is_primary,true);assert.ok(listedPerson.full_name);
await pg.close();
console.log('PASS: repeatable migration, legacy primary, multiple assignees, canonical IDs, idempotence, versions, tenant/role/membership guards, archive chain, FK guards, audit and rollback');
