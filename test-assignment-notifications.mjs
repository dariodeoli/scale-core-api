import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {identitySchema} from './scripts/test-identity-schema.mjs';
import {projectAssignees} from './project-assignees.js';
import {notifications} from './notifications.js';
import {deliverNotifications} from './automation.js';
const pg=new PGlite();
await pg.exec(await fs.readFile('schema.sql','utf8'));
for(const name of ['20260908_treasury_ledger','20260908_people_commissions_comments','20260908_operations_complete','20260908_referral_discounts','20260908_collaborator_profiles','20260908_agency_suite','20260908_daily_controls'])await pg.exec(await fs.readFile(`migrations/${name}.sql`,'utf8'));
await identitySchema(pg);
for(const name of ['20260910_notifications','20260910_project_assignees'])await pg.exec(await fs.readFile(`migrations/${name}.sql`,'utf8'));
const query=(s,v)=>pg.query(s,v),db={query,connect:async()=>({query,release(){}})};
const insert=async(s,v)=>(await query(s+' returning id',v)).rows[0].id;
const org=await insert("insert into organizations(slug,name) values('notice-a','A')");
const otherOrg=await insert("insert into organizations(slug,name) values('notice-b','B')");
const people=[];
for(let i=0;i<4;i++){
 const id=await insert("insert into users(email,password_hash) values($1,'unused')",[`notifier${i}@example.com`]);people.push(id);
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[i===3?otherOrg:org,id]);
}
const [owner,one,two,foreign]=people;
const user={id:owner,organization_id:org,role:'owner'};
const client=await insert("insert into agency_clients(organization_id,name) values($1,'Client')",[org]);
const project=await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Project')",[org,client]);
const order=await insert("insert into agency_work_orders(organization_id,project_id,title) values($1,$2,'Order')",[org,project]);
const migration=await fs.readFile('migrations/20260911_assignment_notifications.sql','utf8');await pg.exec(migration);await pg.exec(migration);
async function call(handler,path,as=user,method='GET',payload={}){let r;await handler({req:{method,socket:{}},res:{},url:new URL('https://test/api/agency/'+path),db,session:async()=>as,body:async()=>payload,send:(_,status,data)=>r={status,...data}});return r;}
async function assign(kind,key,ids,primary=ids[0]??null){
 const path=`${kind}/${key}/assignees`,state=await call(projectAssignees,path);
 return call(projectAssignees,path,user,'PATCH',{assigned_user_ids:ids.map(String),assigned_user_id:primary===null?null:String(primary),expected_version:state.assignee_version});
}
const notices=async()=>(await query("select * from agency_notifications where kind='assignment' order by id")).rows;
assert.equal((await assign('projects',project,[one,two,owner])).status,200);
let n=await notices();assert.equal(n.length,3);assert.deepEqual(n.map(n=>n.user_id).sort(),[owner,one,two].sort());assert(n.every(n=>n.project_id===project&&n.work_order_id===null));
assert.equal((await assign('projects',project,[one,two,owner])).status,200);assert.equal((await notices()).length,3);
assert.equal((await assign('projects',project,[owner,two,one],two)).status,200);assert.equal((await notices()).length,3,'Primary promotion/demotion does not resend');
assert.equal((await assign('work-orders',order,[one,two])).status,200);assert.equal((await notices()).length,5);
assert.equal((await assign('work-orders',order,[two,one],two)).status,200);assert.equal((await notices()).length,5);
await query('update agency_work_orders set title=$1 where id=$2',['Renamed',order]);assert.equal((await notices()).length,5);
assert.equal((await assign('work-orders',order,[one])).status,200);assert.equal((await notices()).length,5);
assert.equal((await assign('work-orders',order,[one,two])).status,200);assert.equal((await notices()).length,6,'A genuine re-assignment is a new notification');
assert.equal((await assign('work-orders',order,[foreign])).status,400);assert.equal((await notices()).length,6);
await query('begin');await query('update agency_projects set assigned_user_id=$1 where id=$2',[two,project]);await query('rollback');assert.equal((await notices()).length,6);
await query('begin');
await query('delete from agency_work_order_assignees where organization_id=$1 and work_order_id=$2 and user_id=$3',[org,order,two]);
await query('insert into agency_work_order_assignees(organization_id,work_order_id,user_id) values($1,$2,$3)',[org,order,two]);
await query('commit');assert.equal((await notices()).length,6,'Same final set in one transaction is unchanged');

// Per-category opt-out is preserved; the read/resolve APIs stay recipient scoped.
const asOne={...user,id:one},asTwo={...user,id:two};
assert.equal((await call(notifications,'notifications/preferences',asTwo,'PATCH',{assignment:false})).status,200);
await assign('work-orders',order,[one]);await assign('work-orders',order,[one,two]);assert.equal((await notices()).length,6);
let inbox=await call(notifications,'notifications',asOne);assert.equal(inbox.status,200);assert.equal(inbox.pendingCount,2);
const key=inbox.notifications[0].id;
assert.equal((await call(notifications,'notifications/'+key,asTwo,'PATCH',{resolved:true})).status,404);
let resolved=await call(notifications,'notifications/'+key,asOne,'PATCH',{resolved:true});assert.equal(resolved.status,200);assert(resolved.resolved_at);assert(resolved.read_at);
const again=await call(notifications,'notifications/'+key,asOne,'PATCH',{resolved:true});assert.deepEqual(again,resolved);
inbox=await call(notifications,'notifications',asOne);assert.equal(inbox.pendingCount,1);assert.equal(inbox.unread,1);
assert.equal((await call(notifications,'notifications/'+key,asOne,'PATCH',{resolved:false})).status,200);
inbox=await call(notifications,'notifications',asOne);assert.equal(inbox.pendingCount,2);assert.equal(inbox.unread,1);
assert.equal((await query('select email_status from agency_notifications where id=$1',[key])).rows[0].email_status,'skipped','Reopening never requeues email');
assert.equal((await call(notifications,'notifications/read-all',asOne,'PATCH',{})).status,200);
inbox=await call(notifications,'notifications',asOne);assert.equal(inbox.unread,0);assert.equal(inbox.pendingCount,2,'Read is distinct from resolved');
assert.equal((await call(notifications,'notifications/'+key,asOne,'PATCH',{resolved:'true'})).status,400);
assert.equal((await call(notifications,'notifications/read-all',asOne,'PATCH',{resolved:true})).status,400);
assert.equal((await call(notifications,'notifications/'+key,null,'PATCH',{})).status,401);
let emailCalls=0;
await deliverNotifications(db,{apiKey:'fixture',from:'fixture@example.com',appUrl:'https://example.com',fetcher:async()=>{emailCalls++;return{ok:true};}});
assert.equal(emailCalls,0,'Existing worker requires explicit email opt-in; no actual network');
// Filter in SQL before cursor/limit, with global counters across every page.
await query(`insert into agency_notifications(organization_id,user_id,kind,title,body,dedupe_key,read_at,resolved_at)
 select $1,$2,'comment','Page '||n,'Fixture','page:'||n,
 case when n%2=0 or n%3=0 then now() else null end,
 case when n%2=0 then now() else null end from generate_series(1,70) n`,[org,one]);
await query("insert into agency_notifications(organization_id,user_id,kind,title,dedupe_key) values($1,$2,'comment','Foreign private','foreign')",[otherOrg,foreign]);
const globalCounts=await call(notifications,'notifications',asOne);
for(const [filter,predicate] of [['all','true'],['unread','read_at is null'],['unresolved','resolved_at is null'],['resolved','resolved_at is not null']]){
 const expected=(await query('select id from agency_notifications where organization_id=$1 and user_id=$2 and '+predicate+' order by id desc',[org,one])).rows.map(r=>r.id);
 let cursor=null,actual=[];
 do{
  const page=await call(notifications,'notifications?status='+filter+(cursor?'&cursor='+cursor:''),asOne);
  assert.equal(page.status,200);assert.equal(page.unread,globalCounts.unread);assert.equal(page.pendingCount,globalCounts.pendingCount);
  assert(page.notifications.length<=30);actual.push(...page.notifications.map(r=>r.id));cursor=page.next;
 }while(cursor);
 assert.deepEqual(actual,expected,filter+' must filter before limit, preserve order, and never leak other inboxes');
}
const firstResolved=await call(notifications,'notifications?status=resolved',asOne);
assert(firstResolved.next);
assert.deepEqual((await call(notifications,'notifications?status=resolved&before='+firstResolved.next,asOne)).notifications,
 (await call(notifications,'notifications?status=resolved&cursor='+firstResolved.next,asOne)).notifications,'Legacy before cursor remains compatible');
for(const params of ['status=','status=bogus','status=all&status=resolved','cursor=-1','cursor=1.5','cursor=abc','cursor=2&before=3'])assert.equal((await call(notifications,'notifications?'+params,asOne)).status,400);
await query('update organization_members set active=false where organization_id=$1 and user_id=$2',[org,one]);
assert.equal((await call(notifications,'notifications/'+key,asOne,'PATCH',{resolved:true})).status,403);
const existingAlerts=(await query('select * from agency_notifications order by id')).rows;
await pg.exec(migration);assert.equal((await notices()).length,6,'Migration reruns do not notify historical assignments');
assert.deepEqual((await query('select * from agency_notifications order by id')).rows,existingAlerts,'Migration does not change any existing alert, read/resolved state, or email status');
await pg.close();console.log('PASS: all project/order assignees, self assignment, final-set dedup, re-assignment, rollback, tenant guards, preferences, read/resolve, no outbound email.');
