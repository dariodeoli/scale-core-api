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

await load('migrations/20260911_drive_links.sql');
await load('migrations/20260912_urgency.sql');await load('migrations/20260912_urgency.sql');
const {normalizeUrgency}=await import('./urgency.js');
for(const value of [null,''])assert.equal(normalizeUrgency(value),null);
for(let i=1;i<=5;i++){assert.equal(normalizeUrgency(i),i);assert.equal(normalizeUrgency(String(i)),i);}
for(const value of [undefined,0,6,-1,1.5,true,{},[],NaN,Infinity,'01','1e0',' 1 '])assert.throws(()=>normalizeUrgency(value));
async function detail(kind,key,payload,as=user){
 let response;
 await suite({req:{method:'PATCH',socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://test/api/agency/'+kind+'/'+key),db,session:async()=>as,body:async()=>payload,send:(_,status,data)=>{response={status,...data};}});
 return response;
}
for(const [kind,key,field] of [['projects',project,'name'],['work-orders',order,'title']]){
 const table=kind==='projects'?'agency_projects':'agency_work_orders';
 const read=async()=>(await query('select * from '+table+' where id=$1',[key])).rows[0];
 assert.equal((await read()).urgency,null,'existing records unset');
 await assert.rejects(()=>query('update '+table+' set urgency=6 where id=$1',[key]));
 for(let n=1;n<=5;n++){const response=await detail(kind,key,{urgency:String(n)});assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.record.urgency,n);}
 assert.equal((await detail(kind,key,{[field]:'Changed details only'})).status,200);
 assert.equal((await read()).urgency,5,'omission preserves urgency');
 const before=await read();
 assert.equal((await detail(kind,key,{urgency:2,[field]:'x'})).status,400);assert.deepEqual(await read(),before,'invalid details rollback urgency');
 for(const value of [0,6,true,'bad'])assert.equal((await detail(kind,key,{urgency:value})).status,400);
 for(const role of ['viewer','sales','finance'])assert.equal((await detail(kind,key,{urgency:1},people[role])).status,403);
 assert.equal((await detail(kind,key,{urgency:1},{...people.viewer,role:'owner'})).status,403,'fresh DB role checked');
 assert.equal((await detail(kind,key,{urgency:1},people.editor)).status,kind==='projects'?403:200);
 assert.equal((await detail(kind,key,{urgency:1},{...user,organization_id:other})).status,404,'tenant isolation');
 await query('update organization_members set active=false where user_id=$1 and organization_id=$2',[user.id,org]);
 assert.equal((await detail(kind,key,{urgency:1})).status,403);
 await query('update organization_members set active=true,removed_at=now() where user_id=$1 and organization_id=$2',[user.id,org]);
 assert.equal((await detail(kind,key,{urgency:1})).status,403);
 await query('update organization_members set removed_at=null where user_id=$1 and organization_id=$2',[user.id,org]);
 const current=await read(),snapshot=await getRecordAssignees({query},user,kind,key);
 const payload={urgency:4,expected_updated_at:current.updated_at,assignees:{assigned_user_ids:[],expected_version:snapshot.assignee_version}};
 assert.equal((await detail(kind,key,{...payload,expected_updated_at:'2000-01-01'})).status,409);
 assert.equal((await detail(kind,key,{...payload,assignees:{...payload.assignees,expected_version:'999999'}})).status,409);
 assert.deepEqual(await read(),current,'assignee conflict rolls back urgency and details');
 assert.equal((await detail(kind,key,payload)).status,200);
 assert.equal((await read()).urgency,4);
 assert.equal((await detail(kind,key,{urgency:''})).status,200);assert.equal((await read()).urgency,null);
}
const server=await fs.readFile(new URL('server.js',import.meta.url),'utf8');
for(const [table,args] of [['agency_projects',['New project',client,null,org,null]],['agency_work_orders',['New piece',project,'to_record',null,null,org,3]]]){
 const sql=server.match(new RegExp("'(insert into "+table+"\\([^']+urgency[^']+returning \\*)'"))[1];
 const row=(await query(sql,args)).rows[0];assert.equal(row.urgency,args.at(-1),'actual creation query persists urgency');
}
await pg.close();console.log('PASS urgency normalization, migration, creation SQL, update, null, roles, tenants, revocation, concurrency and transaction rollback');
