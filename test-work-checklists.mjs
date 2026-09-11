import assert from 'node:assert/strict';
import {identitySchema} from './scripts/test-identity-schema.mjs';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {workChecklists} from './work-checklists.js';

const pg=new PGlite();
await pg.exec(await fs.readFile('schema.sql','utf8'));
for(const name of ['20260908_treasury_ledger','20260908_people_commissions_comments','20260908_operations_complete',
 '20260908_referral_discounts','20260908_collaborator_profiles','20260908_agency_suite','20260908_daily_controls',
 '20260910_productivity','20260910_work_checklists'])await pg.exec(await fs.readFile(`migrations/${name}.sql`,'utf8'));
await pg.exec(await fs.readFile('migrations/20260910_work_checklists.sql','utf8'));
await identitySchema(pg);
const query=(s,v)=>pg.query(s,v),db={connect:async()=>({query,release(){}})};
const insert=async(s,v)=>(await query(s+' returning id',v)).rows[0].id;
const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
const other=await insert("insert into organizations(slug,name) values('checklist-other','Other')");
const uid=await insert("insert into users(email,password_hash) values('checklist@example.invalid','unused')");
await query("insert into organization_members(organization_id,user_id,role) values($1,$3,'owner'),($2,$3,'owner')",[org,other,uid]);
const user={id:uid,organization_id:org,role:'owner'};
async function piece(tenant){
 const client=await insert("insert into agency_clients(organization_id,name) values($1,'Client')",[tenant]);
 const project=await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Project')",[tenant,client]);
 const order=await insert("insert into agency_work_orders(organization_id,project_id,title,description) values($1,$2,'Piece','Texto legado: [ ] Esto no se convierte en ítem')",[tenant,project]);
 return{order,project,client};
}
const first=await piece(org),second=await piece(org),foreign=await piece(other);
const baseline=(await query('select * from agency_work_orders order by id')).rows;
async function call(suffix='',method='GET',payload={},as=user,order=first.order){
 let response;
 const handled=await workChecklists({req:{method,socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL(`https://test/api/agency/work-orders/${order}/checklist${suffix}`),db,session:async()=>as,body:async()=>payload,send:(_,status,data,headers)=>{response={status,...data,headers};}});
 assert.equal(handled,true);return response;
}
assert.equal(await workChecklists({url:new URL('https://test/unrelated')}),false);
assert.equal((await call('','GET',{},null)).status,401);
let result=await call();assert.equal(result.version,'0');assert.deepEqual(result.items,[]);assert.equal(result.total,0);
assert.equal(result.headers['Cache-Control'],'no-store');
assert.equal((await query('select * from agency_work_checklists')).rows.length,0,'GET never seeds a list');
for(const role of ['viewer','finance','sales']){
 assert.equal((await call('','GET',{}, {...user,role})).status,200);
 for(const [suffix,method]of [['/items','POST'],['/items/1','PATCH'],['/items/1','DELETE']])assert.equal((await call(suffix,method,{text:'No',expected_version:'0'}, {...user,role})).status,403);
}
assert.equal((await call('','GET',{}, {...user,organization_id:other})).status,404);
for(const payload of [{text:'No version'},{text:'',expected_version:'0'},{text:' '.repeat(3),expected_version:'0'},
 {text:'x'.repeat(501),expected_version:'0'},{text:'Text',expected_version:-1},{text:'Text',expected_version:'0',completed:true},
 {text:'Text',expected_version:'0',organization_id:other}])assert.equal((await call('/items','POST',payload)).status,400);
result=await call('/items','POST',{text:'  Guion listo  ',expected_version:'0'}, {...user,role:'editor'});
assert.equal(result.status,201);assert.equal(result.version,'1');assert.equal(result.items[0].text,'Guion listo');
const item=result.items[0].id;
assert.equal(result.completed,0);assert.equal(result.total,1);assert.equal(result.max_items,100);
// Two clients read v1. The second cannot overwrite the first client's completion.
result=await call(`/items/${item}`,'PATCH',{completed:true,expected_version:'1'});assert.equal(result.version,'2');assert.equal(result.completed,1);
assert.equal((await call(`/items/${item}`,'PATCH',{text:'Stale edit',expected_version:'1'})).status,409);
assert.equal((await call('/items','POST',{text:'Stale add',expected_version:'1'})).status,409);
assert.equal((await call(`/items/${item}`,'DELETE',{expected_version:'1'})).status,409);
result=await call();assert.equal(result.items[0].text,'Guion listo');assert.equal(result.items[0].completed,true);
result=await call(`/items/${item}`,'PATCH',{text:'Guion aprobado',expected_version:'2'});assert.equal(result.version,'3');assert.equal(result.items[0].completed,true);
assert.equal((await call(`/items/${item}`,'PATCH',{text:'Guion aprobado',expected_version:'3'})).version,'3','no-op does not increment');
assert.equal((await call(`/items/${item}`,'PATCH',{completed:'false',expected_version:'3'})).status,400);
assert.equal((await call(`/items/${item}`,'PATCH',{expected_version:'3'})).status,400);
assert.equal((await call(`/items/${item}`,'DELETE',{expected_version:'0'},user,second.order)).status,404,'same tenant other piece');
assert.equal((await call(`/items/${item}`,'DELETE',{expected_version:'0'},{...user,organization_id:other},foreign.order)).status,404,'other tenant item');
assert.equal((await call('/items','GET')).status,405);
// Recheck actual membership/role, not only the supplied session role.
await query("update organization_members set role='viewer' where organization_id=$1 and user_id=$2",[org,uid]);
assert.equal((await call(`/items/${item}`,'PATCH',{completed:false,expected_version:'3'})).status,403);
await query("update organization_members set role='owner',active=false where organization_id=$1 and user_id=$2",[org,uid]);
assert.equal((await call()).status,403);
await query('update organization_members set active=true where organization_id=$1 and user_id=$2',[org,uid]);
for(const [kind,id]of [['work-orders',first.order],['projects',first.project],['clients',first.client]]){
 await query('insert into agency_archived_records(organization_id,kind,record_id,removed_by) values($1,$2,$3,$4)',[org,kind,id,uid]);
 assert.equal((await call()).status,409);
 assert.equal((await call(`/items/${item}`,'PATCH',{completed:false,expected_version:'3'})).status,409);
 await query('delete from agency_archived_records where organization_id=$1 and kind=$2 and record_id=$3',[org,kind,id]);
}
// Failure after the version increment must roll back the entire operation.
await pg.exec(`create function reject_checklist_test() returns trigger language plpgsql as $$ begin raise exception 'fixture failure'; end $$;
create trigger reject_checklist_test before insert on agency_work_checklist_items for each row execute function reject_checklist_test()`);
assert.equal((await call('/items','POST',{text:'Rollback',expected_version:'3'})).status,500);
assert.equal((await call()).version,'3');
await pg.exec('drop trigger reject_checklist_test on agency_work_checklist_items; drop function reject_checklist_test()');
result=await call(`/items/${item}`,'DELETE',{expected_version:'3'});assert.equal(result.version,'4');assert.equal(result.total,0);assert.equal(result.completed,0);
assert.equal((await call(`/items/${item}`,'DELETE',{expected_version:'4'})).status,404);
assert.equal((await call('/items','POST',{text:'Old empty version',expected_version:'0'})).status,409,'empty list keeps its revision');
// Limit is tested at the boundary with synthetic fixtures, without 100 API requests.
await query("insert into agency_work_checklist_items(organization_id,work_order_id,text,created_by_user_id) select $1,$2,'Item '||n,$3 from generate_series(1,100) n",[org,first.order,uid]);
assert.equal((await call('/items','POST',{text:'101',expected_version:'4'})).status,400);
assert.equal((await call()).items.length,100);
await assert.rejects(query('insert into agency_work_checklist_items(organization_id,work_order_id,text,created_by_user_id) values($1,$2,$3,$4)',[other,first.order,'Cross tenant',uid]),/foreign key/);
assert.deepEqual((await query('select * from agency_work_orders order by id')).rows,baseline,'description, status and legacy metadata unchanged');
assert.ok((await query("select id from agency_operation_audit where organization_id=$1 and table_name='agency_work_checklist_items' and actor=$2",[org,String(uid)])).rows.length>=4);
assert.equal((await query('select * from agency_work_checklists where organization_id=$1',[other])).rows.length,0);
await pg.close();
console.log('PASS: empty additive migration, CRUD/progress, 100-item cap, exact piece/tenant/role guards, archived ancestors, optimistic revision conflicts, transactional rollback, audit and legacy descriptions unchanged');
