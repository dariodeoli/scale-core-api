import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {demoOrganization,privateDemoEntry} from './demo-session.js';
// Match server init, including the final published assignee/inventory/checklist
// dependencies. Optional Dadoo is a separate product, never part of this fixture.
const server=await fs.readFile('server.js','utf8'),start=server.indexOf('async function init()'),end=server.indexOf("await migration.query('commit')",start);
assert(start>=0&&end>start);
const migrations=[...server.slice(start,end).matchAll(/(2026\d{4}_[a-z0-9_]+\.sql)/g)].map(m=>m[1]).filter(f=>f!=='20260908_dadoo_hub.sql');
for(const name of ['20260910_project_assignees.sql','20260910_inventory_reservations.sql','20260910_work_checklists.sql'])assert(migrations.includes(name));
const pg=new PGlite();await pg.exec(await fs.readFile('schema.sql','utf8'));
await pg.exec("set timezone to 'UTC'");
for(const name of migrations)await pg.exec(await fs.readFile('migrations/'+name,'utf8'));
const c={query:(s,v)=>pg.query(s,v)};
const source=(await c.query("insert into organizations(slug,name) values('scale-demo-controles-20260908','Demo') returning id")).rows[0].id;
const real=(await c.query("select id from organizations where slug='scale'")).rows[0].id;
const users=[];
for(let i=0;i<2;i++){const u=(await c.query("insert into users(email,password_hash) values($1,'none') returning id",['test'+i+'@example.invalid'])).rows[0].id;users.push(u);await c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[source,u]);}
async function open(userId,demoKey){await pg.exec('begin');try{const id=await demoOrganization(c,{userId,sourceId:source,demoKey});await pg.exec('commit');return id;}catch(e){await pg.exec('rollback');throw e;}}
const first=await open(users[0],'login-1');assert.notEqual(first,source);
assert.equal(await open(users[0],'login-1'),first);
assert.equal((await c.query('select count(*)::int as n from agency_clients where organization_id=$1',[first])).rows[0].n,20);
assert.equal((await c.query('select count(*)::int as n from agency_work_orders where organization_id=$1',[first])).rows[0].n,80);
const second=await open(users[1],'login-1'),nextLogin=await open(users[0],'login-2');assert.notEqual(first,second);assert.notEqual(first,nextLogin);
await c.query("update agency_clients set name='Edited' where organization_id=$1",[first]);
assert.equal((await c.query("select count(*)::int as n from agency_clients where organization_id=$1 and name='Edited'",[second])).rows[0].n,0);
// Every new copy has tenant-local catalogs, balanced stage-aware responsibility,
// useful progress, and future bookings; no fake live presence is created.
for(const demo of [first,second,nextLogin]){
 const scalar=async sql=>(await c.query(sql,[demo])).rows[0].n;
 assert.equal(await scalar('select count(*)::int n from agency_inventory_categories where organization_id=$1'),7);
 assert.equal(await scalar('select count(*)::int n from agency_inventory i join agency_inventory_categories c on c.id=i.category_id and c.organization_id=i.organization_id and c.name=i.category where i.organization_id=$1 and i.storage_shelf<>\'\''),4);
 assert.equal(await scalar('select count(distinct assigned_user_id)::int n from agency_work_orders where organization_id=$1'),4);
 const owner=(await c.query('select demo_owner_user_id from organizations where id=$1',[demo])).rows[0].demo_owner_user_id;
 const mine=(await c.query("select count(*) filter(where due_date<current_date)::int overdue,count(*) filter(where due_date=current_date)::int today,count(*) filter(where due_date>current_date)::int future from agency_work_orders where organization_id=$1 and assigned_user_id=$2 and status not in ('approved','published')",[demo,owner])).rows[0];
 assert(mine.overdue>0&&mine.today>0&&mine.future>0,'Visitor Mi día needs pending overdue/today/future pieces');
 assert.equal(await scalar("select count(*)::int n from agency_work_orders where organization_id=$1 and status='published' and due_date<>current_date-1"),0);
 assert.equal(await scalar("select count(*)::int n from agency_work_orders w join organization_members m on m.user_id=w.assigned_user_id and m.organization_id=w.organization_id where w.organization_id=$1 and m.role in ('finance','sales')"),0);
 assert.equal(await scalar('select count(*)::int n from agency_projects where organization_id=$1 and assigned_user_id is not null'),20);
 assert.equal(await scalar('select count(*)::int n from agency_project_assignees where organization_id=$1'),20);
 assert.equal(await scalar('select count(*)::int n from agency_work_checklists where organization_id=$1'),80);
 assert.equal(await scalar('select count(*)::int n from agency_work_checklist_items where organization_id=$1'),240);
 assert.equal(await scalar("select count(*)::int n from (select w.id from agency_work_orders w join agency_work_checklist_items i on i.work_order_id=w.id and i.organization_id=w.organization_id where w.organization_id=$1 group by w.id having count(*)<>3 or count(*) filter(where i.completed)<>case w.status when 'blocked' then 0 when 'to_record' then 1 when 'recorded' then 1 when 'editing' then 2 when 'review' then 2 else 3 end) invalid"),0);
 assert.equal(await scalar("select count(*)::int n from agency_inventory_reservations where organization_id=$1 and status='reserved' and starts_at>now() and (starts_at at time zone 'America/Asuncion')::date between (now() at time zone 'America/Asuncion')::date+2 and (now() at time zone 'America/Asuncion')::date+3 and (starts_at at time zone 'America/Asuncion')::time=time '09:00' and (ends_at at time zone 'America/Asuncion')::time=time '12:00' and ends_at-starts_at=interval '3 hours' and custodian_user_id is null and checked_out_at is null"),2);
 assert.equal(await scalar('select count(*)::int n from agency_inventory_reservation_items where organization_id=$1'),4);
 assert.equal(await scalar('select count(*)::int n from agency_inventory_reservation_members where organization_id=$1'),4);
 assert.equal(await scalar("select count(*)::int n from agency_inventory_reservation_items ri join agency_inventory i on i.id=ri.inventory_id and i.organization_id=ri.organization_id join agency_inventory_reservations r on r.id=ri.reservation_id and r.organization_id=ri.organization_id where ri.organization_id=$1 and i.status='available' and i.custodian_user_id is null and ri.status=r.status and ri.starts_at=r.starts_at and ri.ends_at=r.ends_at"),4);
 assert.equal(await scalar('select count(*)::int n from agency_inventory_reservations r where r.organization_id=$1 and not exists(select 1 from agency_inventory_reservation_members m where m.organization_id=r.organization_id and m.reservation_id=r.id and m.user_id=r.return_user_id)'),0);
 assert.equal(await scalar("select count(*)::int n from agency_inventory_reservation_items a join agency_inventory_reservation_items b on a.inventory_id=b.inventory_id and a.reservation_id<b.reservation_id and a.starts_at<b.ends_at and b.starts_at<a.ends_at where a.organization_id=$1"),0);
 assert.equal(await scalar("select count(*)::int n from agency_inventory_reservation_items r join agency_archived_records a on a.organization_id=r.organization_id and a.kind='inventory' and a.record_id=r.inventory_id where r.organization_id=$1"),0);
}
const tenantTables=['agency_clients','agency_projects','agency_work_orders','agency_project_assignees','agency_work_order_assignees','agency_work_checklists','agency_work_checklist_items','agency_inventory_categories','agency_inventory','agency_inventory_reservations','agency_inventory_reservation_members','agency_inventory_reservation_items','organization_members','agency_user_profiles','agency_collaborators'];
const snapshot=async org=>Object.fromEntries(await Promise.all(tenantTables.map(async table=>[table,(await c.query(`select to_jsonb(t)::text as row from ${table} t where organization_id=$1 order by to_jsonb(t)::text`,[org])).rows])));
const firstOrder=(await c.query('select id from agency_work_orders where organization_id=$1 order by id limit 1',[first])).rows[0].id;
await c.query("update agency_work_orders set assigned_user_id=$1,title='Edición conservada' where organization_id=$2 and id=$3",[users[0],first,firstOrder]);
await c.query("update agency_work_checklist_items set text='Paso personalizado',completed=true where organization_id=$1 and work_order_id=$2",[first,firstOrder]);
const before=await snapshot(first),realBefore=await snapshot(real),templateBefore=await snapshot(source),secondBefore=await snapshot(second);
const globalBefore=(await c.query('select * from user_personal_identities order by user_id')).rows;
assert.equal(await open(users[0],'login-1'),first);
const another=await open(users[0],'login-3');assert.notEqual(another,first);
assert.deepEqual(await snapshot(first),before,'Existing demo edits must not be reseeded or reassigned');
assert.deepEqual(await snapshot(second),secondBefore,'Other visitor stays unchanged');
assert.deepEqual(await snapshot(real),realBefore,'Real organization stays unchanged');
assert.deepEqual(await snapshot(source),templateBefore,'Shared template stays unchanged');
assert.deepEqual((await c.query('select * from user_personal_identities order by user_id')).rows,globalBefore,'Seeding never writes canonical identities');
assert.equal((await c.query('select count(*)::int as n from agency_clients where organization_id=$1',[real])).rows[0].n,0);
assert.equal((await c.query('select count(*)::int as n from agency_clients where organization_id=$1',[source])).rows[0].n,0);
assert.equal((await c.query('select count(*)::int as n from organization_members where organization_id=$1',[first])).rows[0].n,6);
const accounts=(await c.query("select balance from bank_accounts where organization_id=$1 and currency='PYG' order by id",[first])).rows;
assert.equal(Number(accounts[0].balance),35250000);assert.equal(Number(accounts[1].balance),1000000);
const continental=(await c.query("select name,institution,account_number,holder_name from bank_accounts where organization_id=$1 and account_number='310056630007'",[first])).rows[0];
assert.equal(continental.name,'Banco Continental · Caja de ahorro en guaraníes');
assert.equal(continental.institution,'Banco Continental');
assert.equal(continental.holder_name,'SCALE STRATEGY GROUP E.A.S.');
assert.equal((await c.query('select name from organizations where id=$1',[first])).rows[0].name,'Agencia Horizonte');
await assert.rejects(()=>demoOrganization(c,{userId:users[1],sourceId:first,demoKey:'other'}),{status:403});
const fresh=(await c.query("insert into users(email,password_hash) values('fresh-owner@example.invalid','none') returning id")).rows[0].id;
await c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')",[real,fresh]);
assert.equal(await privateDemoEntry(c,fresh),null);
await assert.rejects(()=>open(fresh,'fresh-login'),{status:403});
await c.query("update organization_members set role='owner' where organization_id=$1 and user_id=$2",[real,fresh]);
assert.equal(String((await privateDemoEntry(c,fresh)).id),String(source));
const personal=await open(fresh,'fresh-login');assert.notEqual(personal,source);
assert.equal((await c.query('select count(*)::int as n from organization_members where organization_id=$1 and user_id=$2',[source,fresh])).rows[0].n,0);
assert.equal((await c.query('select count(*)::int as n from agency_clients where organization_id=$1',[personal])).rows[0].n,20);
await assert.rejects(()=>demoOrganization(c,{userId:fresh,sourceId:first,demoKey:'fresh-login'}),{status:403});
await c.query("insert into organization_members(organization_id,user_id,role,active) values($1,$2,'owner',false)",[source,fresh]);assert.equal(await privateDemoEntry(c,fresh),null);
console.log('PASS: new demos with linked categories, stage-aware assignees, 80 checklists/240 items, 2 non-overlapping future reservations; existing demos/other visitors/real data/roles/global identities unchanged; per-login reset and finance balances preserved');
await pg.close();
