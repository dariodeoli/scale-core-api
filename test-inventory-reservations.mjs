import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {inventoryReservations,inventoryTimestamp} from './inventory-reservations.js';

const pg=new PGlite();await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
for(const name of ['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql','20260910_productivity.sql','20260910_currencies.sql','20260910_company_currency.sql'])await pg.exec(await fs.readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8'));
const query=(sql,args)=>pg.query(sql,args);
const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
const other=(await query("insert into organizations(slug,name) values('inventory-other','Other') returning id")).rows[0].id;
const users=[];
for(const [index,role] of ['owner','production','production','viewer','finance','sales','editor','management'].entries()){
 const id=(await query('insert into users(email,password_hash) values($1,$2) returning id',[`inventory${index}@example.invalid`,'unused'])).rows[0].id;
 await query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3)',[org,id,role]);users.push({id,role,organization_id:org});
}
const [owner,producer,secondProducer,viewer,finance,sales,editor,management]=users;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[other,owner.id]);
const client=(await query("insert into agency_clients(organization_id,name) values($1,'Fixture client') returning id",[org])).rows[0].id;
const project=(await query("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Fixture project') returning id",[org,client])).rows[0].id;
const otherClient=(await query("insert into agency_clients(organization_id,name) values($1,'Other client') returning id",[other])).rows[0].id;
const otherProject=(await query("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Other project') returning id",[other,otherClient])).rows[0].id;
const legacy=(await query("insert into agency_inventory(organization_id,name,category,value,currency) values($1,'Old card','Memoria',0,'USD') returning id",[org])).rows[0].id;
const migration=await fs.readFile(new URL('./migrations/20260910_inventory_reservations.sql',import.meta.url),'utf8');await pg.exec(migration);await pg.exec(migration);
assert((await query('select category_id from agency_inventory where id=$1',[legacy])).rows[0].category_id);
await query("insert into agency_settings(organization_id,default_currency) values($1,'EUR')",[org]);
// PGlite has one connection. Queue leased transactions, as a size-1 pg Pool does.
let tail=Promise.resolve();
const db={connect:async()=>{let unlock;const prior=tail;tail=new Promise(resolve=>{unlock=resolve;});await prior;return {query,release(){unlock();}};}};
async function call(path,method='GET',payload={},user=owner){
 let result;const handled=await inventoryReservations({req:{method,socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://test/api/agency/'+path),db,session:async()=>user,body:async()=>payload,send:(_,status,data)=>{result={status,...data};}});
 assert(handled);return result;
}
const iso=offset=>new Date(Date.now()+offset).toISOString();
const start=iso(-60000),end=iso(3600000),later=iso(7200000);
const reservationPayload=items=>({title:'Rodaje memoria y DJI Mic',project_id:project,starts_at:start,ends_at:end,inventory_ids:items,responsible_user_ids:[producer.id,secondProducer.id],return_user_id:secondProducer.id,notes:'Fixture only'});

assert.equal((await call('inventory','GET',{},null)).status,401);
assert.equal((await call('inventory','GET',{},sales)).status,403);
for(const user of [producer,viewer,finance,editor])assert.equal((await call('inventory','POST',{name:'Forbidden'},user)).status,403);
for(const user of [viewer,finance,editor])assert.equal((await call('inventory-reservations','POST',{},user)).status,403);
assert.equal((await call('inventory-context','GET',{},viewer)).members.length,0);
assert.equal((await call('inventory-context','GET',{},producer)).can_reserve,true);
let category=(await call('inventory-categories','POST',{name:'Memorias y almacenamiento'},management)).category;
assert(category);assert.equal((await call('inventory-categories','POST',{name:' memorias y almacenamiento '})).status,409);
assert.equal((await call(`inventory-categories/${category.id}`,'PATCH',{name:'Nope'},producer)).status,403);
let item=(await call('inventory','POST',{name:'Memoria SD 128 GB',category_id:category.id,storage_shelf:'Estante A',storage_row:'2'})).record;
assert.equal(item.currency,'EUR');const card=String(item.id);
let mic=(await call('inventory','POST',{name:'DJI Mic',category:'Audio',value:100,currency:'USD'})).record;const micId=String(mic.id);
assert.equal(mic.currency,'USD');
assert.equal((await call(`inventory/${card}`,'PATCH',{name:'Memoria SD'})).record.currency,'EUR');
assert.equal((await call(`inventory-categories/${category.id}`,'PATCH',{name:'Memorias'})).status,200);
assert.equal((await call(`inventory/${card}`)).record.category,'Memorias');
assert.equal((await call(`inventory-categories/${category.id}`,'PATCH',{active:false})).status,200);
assert.equal((await call('inventory','POST',{name:'New card',category_id:category.id})).status,400);
assert.equal((await call(`inventory/${card}`,'PATCH',{name:'Existing card'})).status,200);
assert.equal((await call(`inventory-categories/${category.id}`,'PATCH',{active:true})).status,200);
const foreign=(await call('inventory','POST',{name:'Other equipment'},{...owner,organization_id:other})).record;
assert.equal((await call(`inventory/${card}`,'GET',{}, {...owner,organization_id:other})).status,404);
assert.equal((await call('inventory-reservations','POST',reservationPayload([card,foreign.id]),producer)).status,400);
assert.equal((await call('inventory-reservations','POST',{...reservationPayload([card]),project_id:otherProject},producer)).status,400);
assert.equal((await call('inventory-reservations','POST',reservationPayload([card,card]),producer)).status,400);
assert.equal((await call('inventory-reservations','POST',{...reservationPayload([card]),return_user_id:owner.id},producer)).status,400);
assert.equal((await call('inventory-reservations','POST',{...reservationPayload([card]),responsible_user_ids:[secondProducer.id]},producer)).status,400);
await query('update organization_members set active=false where organization_id=$1 and user_id=$2',[org,secondProducer.id]);
assert.equal((await call('inventory-reservations','POST',reservationPayload([card]),producer)).status,400);
await query('update organization_members set active=true where organization_id=$1 and user_id=$2',[org,secondProducer.id]);
await query("update agency_projects set status='paused' where id=$1",[project]);
assert.equal((await call('inventory-reservations','POST',reservationPayload([card]),producer)).status,400);
await query("update agency_projects set status='active' where id=$1",[project]);
await query('update agency_clients set active=false where id=$1',[client]);
assert.equal((await call('inventory-reservations','POST',reservationPayload([card]),producer)).status,400);
await query('update agency_clients set active=true where id=$1',[client]);
for(const invalid of ['2026-02-30T12:00:00Z','2026-09-10T12:00','nonsense'])assert.throws(()=>inventoryTimestamp(invalid));
assert.equal((await call('inventory-reservations','POST',{...reservationPayload([card]),ends_at:start},producer)).status,400);

// Simultaneous API calls contend for the same equipment; exactly one may commit.
const competing=await Promise.all([call('inventory-reservations','POST',reservationPayload([card,micId]),producer),call('inventory-reservations','POST',reservationPayload([card,micId]),producer)]);
assert.deepEqual(competing.map(r=>r.status).sort(),[201,409]);
let row=competing.find(r=>r.status===201).reservation;assert.equal(row.items.length,2);assert.equal(row.responsible_members.length,2);
assert.equal((await call('inventory-reservations','POST',{...reservationPayload([card]),starts_at:end,ends_at:later},producer)).status,201,'adjacent bookings allowed');
assert.equal((await call(`inventory-reservations/${row.id}`,'GET',{}, {...owner,organization_id:other})).status,404);
assert.equal((await call(`inventory-reservations/${row.id}`,'PATCH',{...reservationPayload([card]),expected_version:row.version},secondProducer)).status,403);
assert.equal((await call(`inventory-reservations/${row.id}`,'PATCH',{...reservationPayload([card,micId]),expected_version:99},producer)).status,409);
assert.equal((await call(`inventory/${card}`,'DELETE')).status,409);
assert.equal((await call(`inventory/${card}`,'PATCH',{status:'retired'})).status,409);
await assert.rejects(query("insert into agency_archived_records(organization_id,kind,record_id) values($1,'inventory',$2)",[org,card]),error=>error.code==='23514');
assert.equal((await call(`inventory-reservations/${row.id}/return`,'POST',{expected_version:row.version,locations:[]},producer)).status,409);
assert.equal((await call(`inventory-reservations/${row.id}/checkout`,'POST',{expected_version:row.version,custodian_user_id:owner.id},producer)).status,400);
let checked=await call(`inventory-reservations/${row.id}/checkout`,'POST',{expected_version:row.version,custodian_user_id:producer.id},producer);
assert.equal(checked.status,200);row=checked.reservation;assert.equal(row.status,'checked_out');
assert.equal((await call(`inventory-reservations/${row.id}/checkout`,'POST',{},producer)).alreadyRecorded,true);
const current=(await call(`inventory/${card}`)).record;
assert.equal(current.status,'in_use');assert.equal(current.location_type,'checked_out');assert.equal(String(current.current_custodian_user_id),String(producer.id));
assert.equal((await call(`inventory/${card}`,'PATCH',{storage_shelf:'Invented move'})).status,409);
assert.equal((await call(`inventory-reservations/${row.id}/cancel`,'POST',{expected_version:row.version},producer)).status,409);
assert.equal((await call(`inventory-reservations/${row.id}`,'PATCH',{...reservationPayload([card]),expected_version:row.version},producer)).status,409);
assert.equal((await call(`inventory-reservations/${row.id}/return`,'POST',{expected_version:row.version,locations:[{inventory_id:card,storage_shelf:'A'}]},producer)).status,400);
// A closed project / suspended responsible must not prevent actual returns.
await query("update agency_projects set status='completed' where id=$1",[project]);
await query('update organization_members set active=false where organization_id=$1 and user_id=$2',[org,secondProducer.id]);
const locations=[{inventory_id:card,storage_shelf:'Estante B',storage_row:'3',status:'available'},{inventory_id:micId,storage_shelf:'Revisión técnica',storage_row:'',status:'maintenance'}];
const returned=await call(`inventory-reservations/${row.id}/return`,'POST',{expected_version:row.version,locations},producer);
assert.equal(returned.status,200);assert.equal(returned.reservation.status,'returned');
assert.equal((await call(`inventory/${card}`)).record.storage_shelf,'Estante B');assert.equal((await call(`inventory/${card}`)).record.custodian_user_id,null);
assert.equal((await call(`inventory/${micId}`)).record.status,'maintenance');
assert.equal((await call(`inventory-reservations/${row.id}/return`,'POST',{},producer)).alreadyRecorded,true);
await query("update agency_projects set status='active' where id=$1",[project]);
await query('update organization_members set active=true where organization_id=$1 and user_id=$2',[org,secondProducer.id]);
assert.equal((await call('inventory-reservations','POST',reservationPayload([micId]),producer)).status,400);
// Assignment permits return only for already authorized booker roles, without
// granting editing/cancellation rights or membership permissions.
const lone=(await call('inventory','POST',{name:'Assigned return fixture'})).record;
let assigned=(await call('inventory-reservations','POST',reservationPayload([lone.id]),producer)).reservation;
assigned=(await call(`inventory-reservations/${assigned.id}/checkout`,'POST',{expected_version:assigned.version,custodian_user_id:producer.id},producer)).reservation;
assert.equal((await call(`inventory-reservations/${assigned.id}/return`,'POST',{expected_version:assigned.version,locations:[{inventory_id:lone.id,storage_shelf:'A'}]},secondProducer)).status,200,'designated production returner can return another creator’s booking');
assigned=(await call('inventory-reservations','POST',{...reservationPayload([lone.id]),return_user_id:producer.id},producer)).reservation;
assigned=(await call(`inventory-reservations/${assigned.id}/checkout`,'POST',{expected_version:assigned.version,custodian_user_id:secondProducer.id},producer)).reservation;
assert.equal((await call(`inventory-reservations/${assigned.id}/return`,'POST',{expected_version:assigned.version,locations:[{inventory_id:lone.id,storage_shelf:'B'}]},secondProducer)).status,200,'production custodian can return');
for(const limited of [viewer,editor]){
 const payload={...reservationPayload([lone.id]),responsible_user_ids:[producer.id,limited.id],return_user_id:limited.id};
 assigned=(await call('inventory-reservations','POST',payload,producer)).reservation;
 assigned=(await call(`inventory-reservations/${assigned.id}/checkout`,'POST',{expected_version:assigned.version,custodian_user_id:limited.id},producer)).reservation;
 assert.equal((await call(`inventory-reservations/${assigned.id}/return`,'POST',{expected_version:assigned.version,locations:[{inventory_id:lone.id,storage_shelf:'C'}]},limited)).status,403,'assignment does not grant viewer/editor return permission');
 assert.equal((await call(`inventory-reservations/${assigned.id}/return`,'POST',{expected_version:assigned.version,locations:[{inventory_id:lone.id,storage_shelf:'C'}]},producer)).status,200);
}
const scheduled=(await call('inventory-reservations')).reservations.find(r=>r.status==='reserved');
assert.equal((await call(`inventory-reservations/${scheduled.id}/checkout`,'POST',{expected_version:scheduled.version,custodian_user_id:producer.id},producer)).status,409,'no early checkout');
assert.equal((await call(`inventory-reservations/${scheduled.id}/cancel`,'POST',{expected_version:scheduled.version},producer)).status,200);
assert.equal((await call(`inventory/${card}`,'DELETE')).status,200);
assert.equal((await call(`inventory/${card}`)).status,404);
assert.equal((await call(`inventory/${card}/restore`,'POST')).status,200);

// Database constraints independently reject overlap and double checkout, even
// for an internal writer that omits the API's preflight checks.
const direct=async (a,b)=> (await query("insert into agency_inventory_reservations(organization_id,project_id,title,starts_at,ends_at,created_by_user_id,return_user_id) values($1,$2,'Direct fixture',$3,$4,$5,$5) returning id",[org,project,a,b,owner.id])).rows[0].id;
const first=await direct('2030-01-01T10:00Z','2030-01-01T11:00Z'),overlap=await direct('2030-01-01T10:30Z','2030-01-01T12:00Z');
await query('insert into agency_inventory_reservation_items(organization_id,reservation_id,inventory_id) values($1,$2,$3)',[org,first,card]);
await assert.rejects(query('insert into agency_inventory_reservation_items(organization_id,reservation_id,inventory_id) values($1,$2,$3)',[org,overlap,card]),error=>error.code==='23P01');
const adjacent=await direct('2030-01-01T11:00Z','2030-01-01T12:00Z');
await query('insert into agency_inventory_reservation_items(organization_id,reservation_id,inventory_id) values($1,$2,$3)',[org,adjacent,card]);
await query("update agency_inventory_reservations set status='checked_out' where id=$1",[first]);
await assert.rejects(query("update agency_inventory_reservations set status='checked_out' where id=$1",[adjacent]),error=>error.code==='23505');
assert.equal((await query('select status from agency_inventory_reservations where id=$1',[adjacent])).rows[0].status,'reserved','failed transition rolls back');
await assert.rejects(query("update agency_inventory_reservations set status='cancelled' where id=$1",[first]),error=>error.code==='23514');
assert((await call('inventory-reservations?from=2040-01-01T00:00:00Z&to=2040-02-01T00:00:00Z')).reservations.some(r=>String(r.id)===String(first)),'unreturned equipment remains visible beyond its planned month');
await query("update organization_members set role='viewer' where organization_id=$1 and user_id=$2",[org,producer.id]);
assert.equal((await call('inventory-reservations','POST',reservationPayload([card]),producer)).status,403,'stale session role cannot grant booking permission');
assert.equal((await call('inventory-context','POST')).status,405);
assert((await query("select count(*)::int as count from agency_operation_audit where table_name='agency_inventory_reservations' and actor=$1",[String(producer.id)])).rows[0].count>0);
await pg.close();
console.log('PASS: categories, legacy CRUD, six-currency default, multi-item/responsible booking, tenant/active project/member checks, own production reservations, calendar, checkout/return/cancel, recorded locations, optimistic version, overlapping requests, GiST exclusion, unique checkout, safe archive and audit. Concurrent API requests use a single-connection PGlite pool; real multi-connection PostgreSQL not run.');
