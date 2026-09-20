import assert from 'node:assert/strict';
import {identitySchema} from './scripts/test-identity-schema.mjs';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {inventoryReservations,inventoryTimestamp} from './inventory-reservations.js';

const pg=new PGlite();await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
for(const name of ['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql','20260910_productivity.sql','20260910_currencies.sql','20260910_company_currency.sql'])await pg.exec(await fs.readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8'));
await identitySchema(pg);
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
const verificationMigration=await fs.readFile(new URL('./migrations/20260912_inventory_verifications.sql',import.meta.url),'utf8');await pg.exec(verificationMigration);await pg.exec(verificationMigration);
const advancedInventoryMigration=await fs.readFile(new URL('./migrations/20260913_inventory_advanced_traceability.sql',import.meta.url),'utf8');await pg.exec(advancedInventoryMigration);await pg.exec(advancedInventoryMigration);
await query("update agency_inventory set storage_shelf=' Legacy cage ' where id=$1",[legacy]);
const storageLocationMigration=await fs.readFile(new URL('./migrations/20260914_inventory_storage_locations.sql',import.meta.url),'utf8');await pg.exec(storageLocationMigration);await pg.exec(storageLocationMigration);
const locationPipelineMigration=await fs.readFile(new URL('./migrations/20260915_inventory_location_pipeline.sql',import.meta.url),'utf8');await pg.exec(locationPipelineMigration);await pg.exec(locationPipelineMigration);
const photosMigration=await fs.readFile(new URL('./migrations/20260915_inventory_photos.sql',import.meta.url),'utf8');await pg.exec(photosMigration);await pg.exec(photosMigration);
const categoryIconsMigration=await fs.readFile(new URL('./migrations/20260915_inventory_category_icons.sql',import.meta.url),'utf8');await pg.exec(categoryIconsMigration);await pg.exec(categoryIconsMigration);
const valueMaintenanceMigration=await fs.readFile(new URL('./migrations/20260919_inventory_value_maintenance.sql',import.meta.url),'utf8');await pg.exec(valueMaintenanceMigration);await pg.exec(valueMaintenanceMigration);
assert((await query('select category_id from agency_inventory where id=$1',[legacy])).rows[0].category_id);
await query("insert into agency_settings(organization_id,default_currency) values($1,'EUR')",[org]);
// PGlite has one connection. Queue leased transactions, as a size-1 pg Pool does.
let tail=Promise.resolve(),checkoutClock=null,apiCases=0;
// Override only the checkout wall-clock read to exercise sequential handovers
// without sleeping. All storage, locks, constraints and transactions remain real.
const leaseQuery=(sql,args)=>checkoutClock&&sql==='select now() as now'?Promise.resolve({rows:[{now:checkoutClock}]}):query(sql,args);
const db={connect:async()=>{let unlock;const prior=tail;tail=new Promise(resolve=>{unlock=resolve;});await prior;return {query:leaseQuery,release(){unlock();}};}};
async function call(path,method='GET',payload={},user=owner){
 let result;const handled=await inventoryReservations({req:{method,socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://test/api/agency/'+path),db,session:async()=>user,body:async()=>payload,send:(_,status,data)=>{result={status,...data};}});
 assert(handled);apiCases++;return result;
}
const iso=offset=>new Date(Date.now()+offset).toISOString();
const start=iso(-60000),end=iso(3600000),later=iso(7200000);
const reservationPayload=items=>({title:'Rodaje memoria y DJI Mic',project_id:project,starts_at:start,ends_at:end,inventory_ids:items,responsible_user_ids:[producer.id,secondProducer.id],return_user_id:secondProducer.id,notes:'Fixture only'});

assert.equal((await call('inventory','GET',{},null)).status,401);
assert.equal((await call('inventory','GET',{},sales)).status,200,'every role can view the inventory catalog');
for(const user of [viewer,editor,sales])assert.equal((await call('inventory','POST',{name:'Forbidden'},user)).status,403);
for(const user of [producer,finance])assert.equal((await call('inventory','POST',{name:'Managed by role',storage_shelf:'A'},user)).status,201,'production and finance manage equipment and locations');
for(const user of [viewer,finance,editor,sales])assert.equal((await call('inventory-reservations','POST',{},user)).status,403);
assert.equal((await call('inventory-context','GET',{},viewer)).members.length,0);
assert.equal((await call('inventory-context','GET',{},producer)).can_reserve,true);
let category=(await call('inventory-categories','POST',{name:'Memorias y almacenamiento'},management)).category;
assert(category);assert.equal((await call('inventory-categories','POST',{name:' memorias y almacenamiento '})).status,409);
assert.equal((await call(`inventory-categories/${category.id}`,'PATCH',{name:'Nope'},viewer)).status,403);
let item=(await call('inventory','POST',{name:'Memoria SD 128 GB',category_id:category.id,storage_shelf:'Estante A',storage_row:'2'})).record;
assert.equal(item.currency,'EUR');const card=String(item.id);assert.equal(item.inventory_code,`INV-${card.padStart(4,'0')}`);
assert.equal(item.barcode_payload,`SCALE-INVENTORY:${item.inventory_code}`);
assert(item.location_changed_at,'new items record when they entered their location');
let mic=(await call('inventory','POST',{name:'DJI Mic',category:'Audio',value:100,currency:'USD'})).record;const micId=String(mic.id);
assert.equal(mic.currency,'USD');
const photoItem=(await call('inventory','POST',{name:'Monitor con foto',category_id:category.id,storage_shelf:'Estante A',photo_url:'https://example.invalid/equipment.png'})).record;
assert.equal(photoItem.photo_url,'https://example.invalid/equipment.png','equipment photos persist by link');
assert.equal((await call(`inventory/${photoItem.id}`,'PATCH',{name:'Monitor renombrado'})).record.photo_url,'https://example.invalid/equipment.png','photo survives unrelated updates');
assert.equal((await call(`inventory/${photoItem.id}`,'PATCH',{photo_url:''})).record.photo_url,null,'an empty photo clears the image');
assert.equal((await call(`inventory/${photoItem.id}`,'PATCH',{photo_url:'javascript:alert(1)'})).status,400,'non-HTTPS photo sources are rejected');
assert.equal((await call(`inventory/${card}`,'PATCH',{name:'Memoria SD'})).record.currency,'EUR');
assert.equal((await call(`inventory/${card}`,'PATCH',{inventory_code:'INV-REASSIGNED'})).status,409,'A physical asset code cannot be reassigned');
assert.equal((await call(`inventory/${card}`,'PATCH',{serial_number:'  sn-12 34_x '})).record.serial_number,'SN1234X','seriales se guardan normalizados (mayúsculas, sin separadores)');
assert.equal(new Date((await call(`inventory/${card}`,'PATCH',{name:'Memoria SD'})).record.location_changed_at).toISOString(),new Date(item.location_changed_at).toISOString(),'an unchanged location keeps the original timestamp');
const moved=await call(`inventory/${card}`,'PATCH',{storage_shelf:'Estante C'});
assert.equal(moved.status,200);assert(moved.record.location_changed_at>item.location_changed_at,'moving to another shelf updates the location timestamp');
assert.equal((await query(`select count(*)::int as n from agency_inventory_trace where inventory_id=$1 and event_type='location.changed'`,[card])).rows[0].n,1,'location moves leave a trace event');
let verified=await call(`inventory/${card}/verify`,'POST',{result:'difference',counted_quantity:1,differences:'Ubicación física: estante B',note:'Control mensual',adjustment:{storage_shelf:'Estante B',storage_row:'4',status:'available'}},management);
assert.equal(verified.status,200);assert.equal(verified.record.last_verification_result,'difference');assert.equal(verified.record.storage_shelf,'Estante B');assert.equal(verified.verification.counted_quantity,1);assert.equal(verified.verification.verified_by_user_id,management.id);assert(verified.verification.verified_at);
assert.equal(verified.record.storage_location_id,null,'verification adjustments retain legacy free-text locations');
let trace=await call(`inventory/${card}`);assert.equal(trace.verifications.length,1);assert.equal(trace.verifications[0].adjusted,true);assert.equal(trace.verifications[0].verified_by_user_id,management.id);assert.equal(trace.verifications[0].counted_quantity,1);assert(trace.verifications[0].verified_at);assert.equal(trace.record.last_verified_counted_quantity,1);assert(trace.trace.some(event=>event.event_type==='inventory.created'));assert(trace.trace.some(event=>event.event_type==='stock.verified'));
assert.equal((await call(`inventory/${card}/verify`,'POST',{result:'confirmed',counted_quantity:2})).status,400);
const batch=await call('inventory/batch','POST',{ids:[card,micId],change:{verify:true,location:{storage_shelf:'Estante Lote',storage_row:'7'}}},management);
assert.equal(batch.status,200);assert.equal(batch.verified,2);assert.equal(batch.moved,2,'the batch verifies and moves every selected item');
const batchCard=await call(`inventory/${card}`);assert.equal(batchCard.record.last_verification_result,'confirmed');assert.equal(batchCard.record.storage_shelf,'Estante Lote');assert.equal(batchCard.record.storage_row,'7');
assert.equal((await call(`inventory/${micId}`)).record.storage_shelf,'Estante Lote','the second selected item moved too');
assert.equal((await call('inventory/batch','POST',{ids:[card,'999999'],change:{verify:true}})).status,404,'every id must belong to the company');
assert.equal((await call('inventory/batch','POST',{ids:[card],change:{}})).status,400,'a batch needs something to change');
const oversizedBatch=await call('inventory/batch','POST',{ids:Array.from({length:51},(_,index)=>String(index+1)),change:{verify:true}});
assert.equal(oversizedBatch.status,400);assert.match(oversizedBatch.error,/1 y 50/,'the batch cap is explicit for the UI');
assert.equal((await call('inventory/batch','POST',{ids:[card],change:{verify:true}},viewer)).status,403,'batch actions require inventory.manage');
assert.equal((await call('inventory-categories','POST',{name:'X'})).status,400,'a category name needs two characters or more');
assert.equal((await call(`inventory-categories/${category.id}`,'PATCH',{name:'X'})).status,400);
assert.equal((await call(`inventory/${card}`)).record.category,'Memorias y almacenamiento','the rejected rename preserves the stored category');
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
assert.equal((await call(`inventory-reservations/${row.id}`,'PATCH',{...reservationPayload([card]),expected_version:row.version},viewer)).status,403);
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
const shelfWhileCheckedOut=(await call(`inventory/${card}`)).record.storage_shelf;
const batchWhileCheckedOut=await call('inventory/batch','POST',{ids:[card],change:{location:{storage_shelf:'Invented batch move'}}},management);
assert.equal(batchWhileCheckedOut.status,409,'a checked-out unit cannot be relocated in a batch either');
assert.equal((await call(`inventory/${card}`)).record.storage_shelf,shelfWhileCheckedOut,'the blocked batch leaves the stored location untouched');
assert.equal((await call(`inventory-reservations/${row.id}/cancel`,'POST',{expected_version:row.version},producer)).status,409);
assert.equal((await call(`inventory-reservations/${row.id}`,'PATCH',{...reservationPayload([card]),expected_version:row.version},producer)).status,409);
assert.equal((await call(`inventory-reservations/${row.id}/return`,'POST',{expected_version:row.version,locations:[{inventory_id:card,storage_shelf:'A'}]},producer)).status,400);
// Partial, duplicate, malformed or invalid returns must release nothing.
const beforeReturn=(await call(`inventory-reservations/${row.id}`)).reservation;
const beforeItems=(await call('inventory')).records;
for(const invalidLocations of [
 [{inventory_id:card,storage_shelf:'A'}],
 [{inventory_id:card,storage_shelf:'A'},{inventory_id:card,storage_shelf:'B'}],
 [{inventory_id:card,storage_shelf:'A'},null],
 [{inventory_id:card,storage_shelf:'A'},{inventory_id:micId,storage_shelf:' '}],
 [{inventory_id:card,storage_shelf:'A'},{inventory_id:foreign.id,storage_shelf:'B'}],
 [{inventory_id:card,storage_shelf:'A'},{inventory_id:micId,storage_shelf:'B',status:'retired'}]
]){
 assert.equal((await call(`inventory-reservations/${row.id}/return`,'POST',{expected_version:row.version,locations:invalidLocations},producer)).status,400);
 assert.deepEqual((await call(`inventory-reservations/${row.id}`)).reservation,beforeReturn,'failed return preserves status, version and all assignees');
 assert.deepEqual((await call('inventory')).records,beforeItems,'failed return cannot free stock or rewrite a location');
}
// A closed project / suspended responsible must not prevent actual returns.
await query("update agency_projects set status='completed' where id=$1",[project]);
await query('update organization_members set active=false where organization_id=$1 and user_id=$2',[org,secondProducer.id]);
const locations=[{inventory_id:card,storage_shelf:'Estante B',storage_row:'3',status:'available'},{inventory_id:micId,storage_shelf:'Revisión técnica',storage_row:'',status:'maintenance'}];
const returned=await call(`inventory-reservations/${row.id}/return`,'POST',{expected_version:row.version,locations},producer);
assert.equal(returned.status,200);assert.equal(returned.reservation.status,'returned');
assert.equal((await call(`inventory/${card}`)).record.storage_shelf,'Estante B');assert.equal((await call(`inventory/${card}`)).record.custodian_user_id,null);
assert.equal((await call(`inventory/${micId}`)).record.status,'maintenance');
assert.equal((await call(`inventory-reservations/${row.id}/return`,'POST',{},producer)).alreadyRecorded,true);
trace=await call(`inventory/${card}`);for(const event of ['reservation.reserved','loan.checked_out','loan.checked_in'])assert(trace.trace.some(row=>row.event_type===event),`missing immutable trace event ${event}`);
const traceId=trace.trace[0].id,verificationId=trace.verifications[0].id;
await assert.rejects(query('update agency_inventory_trace set event_type=$1 where id=$2',['inventory.updated',traceId]),error=>error.code==='55000');
await assert.rejects(query('delete from agency_inventory_verifications where id=$1',[verificationId]),error=>error.code==='55000');
await query("update agency_projects set status='active' where id=$1",[project]);
await query('update organization_members set active=true where organization_id=$1 and user_id=$2',[org,secondProducer.id]);
assert.equal((await call('inventory-reservations','POST',reservationPayload([micId]),producer)).status,400);
// Assignment permits return only for already authorized booker roles, without
// granting editing/cancellation rights or membership permissions.
const lone=(await call('inventory','POST',{name:'Assigned return fixture'})).record;
let assigned=(await call('inventory-reservations','POST',reservationPayload([lone.id]),producer)).reservation;
assigned=(await call(`inventory-reservations/${assigned.id}/check-out`,'POST',{expected_version:assigned.version,custodian_user_id:producer.id},producer)).reservation;
assert.equal((await call(`inventory-reservations/${assigned.id}/check-in`,'POST',{expected_version:assigned.version,locations:[{inventory_id:lone.id,storage_shelf:'A'}]},secondProducer)).status,200,'designated production returner can check in another creator’s booking');
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

// Integrated category -> multi-unit booking -> reschedule -> custody -> return.
// Each inventory record is one reservable unit; reservation is not checkout.
const workflowCategory=(await call('inventory-categories','POST',{name:'Workflow units'})).category;
assert.equal((await call('inventory','POST',{name:'Invalid category fixture',category:'   '})).status,400);
const workflowItems=[];
for(const name of ['Workflow card','Workflow mic','Workflow light'])workflowItems.push((await call('inventory','POST',{name,category_id:workflowCategory.id,storage_shelf:'Original shelf',storage_row:'1'})).record);
const [a,b,c]=workflowItems.map(item=>String(item.id));
const currentRange={starts_at:iso(-120000),ends_at:iso(1800000)};
const futureRange={starts_at:'2032-12-31T22:00:00-03:00',ends_at:'2033-01-01T00:00:00-03:00'};
const createBooking=async(ids,range=currentRange)=>{
 const result=await call('inventory-reservations','POST',{...reservationPayload(ids),...range},producer);
 assert.equal(result.status,201,JSON.stringify(result));return result.reservation;
};
let booking=await createBooking([a,b]);
const blocker=await createBooking([c]);
assert.equal((await call(`inventory/${a}`)).record.status,'available','reserved unit is still physically in storage');
assert.equal((await call('inventory-reservations','POST',{...reservationPayload([a]),...currentRange},secondProducer)).status,409,'another responsible cannot double book reserved stock');
const beforeEdit=(await call(`inventory-reservations/${booking.id}`)).reservation;
assert.equal((await call(`inventory-reservations/${booking.id}`,'PATCH',{...reservationPayload([b,c]),...currentRange,expected_version:booking.version},producer)).status,409);
assert.deepEqual((await call(`inventory-reservations/${booking.id}`)).reservation,beforeEdit,'conflicting edit preserves original items, dates and responsible members');
assert.equal((await call(`inventory-reservations/${blocker.id}/cancel`,'POST',{expected_version:blocker.version},producer)).status,200);
const edit=await call(`inventory-reservations/${booking.id}`,'PATCH',{...reservationPayload([b,c]),...currentRange,expected_version:booking.version},producer);
assert.equal(edit.status,200);booking=edit.reservation;assert.equal(booking.version,beforeEdit.version+1);
const released=await createBooking([a]);
assert.equal((await call(`inventory-reservations/${released.id}/cancel`,'POST',{expected_version:released.version},producer)).status,200);
// Renaming and archiving a category must not lose its existing stock/bookings.
assert.equal((await call(`inventory-categories/${workflowCategory.id}`,'PATCH',{name:'Workflow renamed',active:false})).status,200);
assert.equal((await call(`inventory/${b}`)).record.category_name,'Workflow renamed');
assert.equal((await call('inventory','POST',{name:'Inactive category unit',category_id:workflowCategory.id})).status,400);
const pickup=await call(`inventory-reservations/${booking.id}/checkout`,'POST',{expected_version:booking.version,custodian_user_id:secondProducer.id},producer);
assert.equal(pickup.status,200);booking=pickup.reservation;
const handover=await createBooking([b],{starts_at:currentRange.ends_at,ends_at:iso(3600000)});
checkoutClock=new Date(new Date(currentRange.ends_at).getTime()+1000);
assert.equal((await call(`inventory-reservations/${handover.id}/checkout`,'POST',{expected_version:handover.version,custodian_user_id:producer.id},producer)).status,409,'adjacent slot cannot check out equipment physically overdue from the prior booking');
assert.equal((await call(`inventory-reservations/${handover.id}`)).reservation.status,'reserved');
for(const id of [b,c]){
 const unit=(await call(`inventory/${id}`)).record;
 assert.equal(unit.location_type,'checked_out');assert.equal(String(unit.current_custodian_user_id),String(secondProducer.id));
 assert.equal(unit.production_name,booking.title);assert.equal(unit.project_name,'Fixture project');
}
// A batch never mixes a checked-out unit with a free one: the whole request fails.
const mixedBatch=await call('inventory/batch','POST',{ids:[a,b],change:{location:{storage_shelf:'Batch shelf'}}},management);
assert.equal(mixedBatch.status,409,'the batch refuses to relocate checked-out units');
assert.equal((await call(`inventory/${a}`)).record.storage_shelf,'Original shelf','the blocked batch moves nothing, not even the free unit');
// Wrong versions and partial payloads do not alter custody or free either unit.
const fullLocations=[{inventory_id:b,storage_shelf:'Returned shelf',storage_row:'4'},{inventory_id:c,storage_shelf:'Repair bench',status:'maintenance'}];
assert.equal((await call(`inventory-reservations/${booking.id}/return`,'POST',{expected_version:booking.version-1,locations:fullLocations},secondProducer)).status,409);
assert.equal((await call(`inventory-reservations/${booking.id}/return`,'POST',{expected_version:booking.version,locations:fullLocations.slice(0,1)},secondProducer)).status,400);
assert.equal((await call(`inventory/${b}`)).record.location_type,'checked_out');
assert.equal((await call(`inventory/${c}`)).record.location_type,'checked_out');
const completed=await call(`inventory-reservations/${booking.id}/return`,'POST',{expected_version:booking.version,locations:fullLocations},secondProducer);
assert.equal(completed.status,200);assert.equal(completed.reservation.status,'returned');
const stored=(await call(`inventory/${b}`)).record;
assert.equal(stored.status,'available');assert.equal(stored.location_type,'storage');assert.equal(stored.storage_shelf,'Returned shelf');assert.equal(stored.storage_row,'4');assert.equal(stored.current_custodian_user_id,null);
const nextPickup=await call(`inventory-reservations/${handover.id}/checkout`,'POST',{expected_version:handover.version,custodian_user_id:producer.id},producer);
assert.equal(nextPickup.status,200,'physical return unlocks the adjacent booking');
assert.equal((await call(`inventory-reservations/${handover.id}/return`,'POST',{expected_version:nextPickup.reservation.version,locations:[fullLocations[0]]},producer)).status,200);
checkoutClock=null;
assert.equal((await call('inventory-reservations','POST',{...reservationPayload([c]),...currentRange},producer)).status,400,'maintenance return is not available stock');
const future=await createBooking([b],futureRange);
const inWindow=async(from,to)=>(await call(`inventory-reservations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).reservations.some(r=>String(r.id)===String(future.id));
assert.equal(await inWindow('2032-12-01T00:00:00-03:00','2033-01-01T00:00:00-03:00'),true,'December calendar includes local December 31 across UTC year');
assert.equal(await inWindow('2033-01-01T00:00:00-03:00','2033-02-01T00:00:00-03:00'),false,'exclusive end at local midnight does not occupy January');
assert.equal((await call(`inventory-reservations/${future.id}/cancel`,'POST',{expected_version:future.version},producer)).status,200);
await createBooking([b],futureRange); // Cancellation releases the same slot.

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
// Storage-place templates are tenant-local, normalized, and preserve free-text fallback.
const backfilled=(await query(`select i.storage_shelf,i.storage_location_id,l.name from agency_inventory i
 left join agency_inventory_storage_locations l on l.id=i.storage_location_id and l.organization_id=i.organization_id where i.id=$1`,[legacy])).rows[0];
assert(backfilled.storage_location_id,'legacy shelf backfilled to a reusable location');
assert.equal(backfilled.storage_shelf,' Legacy cage ','backfill preserves legacy shelf text');
assert.equal(backfilled.name,'Legacy cage','backfill normalizes the reusable template name');
let place=(await call('inventory-locations','POST',{name:'  Depósito central  '},management));
assert.equal(place.status,201);const placeId=place.location.id;
assert.equal((await call('inventory-locations','POST',{name:'depósito CENTRAL'},management)).status,409,'normalized duplicate rejected per tenant');
const otherPlace=(await call('inventory-locations','POST',{name:'Depósito central'},{...owner,organization_id:other}));
assert.equal(otherPlace.status,201,'different tenants may use the same template name');
const templated=(await call('inventory','POST',{name:'Template location fixture',storage_location_id:placeId},management)).record;
assert.equal(String(templated.storage_location_id),String(placeId));assert.equal(templated.storage_shelf,'Depósito central');
const custom=(await call('inventory','POST',{name:'Custom location fixture',storage_location_id:'custom',storage_location_name:'Mesa de reparación'},management)).record;
assert.equal(custom.storage_location_id,null);assert.equal(custom.storage_shelf,'Mesa de reparación');
const created=(await call('inventory','POST',{name:'New location fixture',storage_location_id:'new',storage_location_name:'Rack de audio'},management)).record;
assert(created.storage_location_id);assert.equal(created.storage_shelf,'Rack de audio');
await assert.rejects(query('update agency_inventory set storage_location_id=$1 where id=$2',[otherPlace.location.id,templated.id]),error=>error.code==='23503');
assert.equal((await call(`inventory-locations/${placeId}`,'DELETE',{},management)).status,409,'referenced place cannot be deleted');
place=await call(`inventory-locations/${placeId}`,'PATCH',{name:'Depósito principal',active:false},management);
assert.equal(place.status,200);assert.equal(place.location.name,'Depósito principal');assert.equal(place.location.active,false);
assert.equal((await call(`inventory/${templated.id}`)).record.storage_location_name,'Depósito principal','renaming updates the template presentation without rewriting stock');
assert.equal((await call('inventory','POST',{name:'Inactive location fixture',storage_location_id:placeId},management)).status,400);
assert.equal((await call(`inventory/${templated.id}`,'PATCH',{name:'Existing archived template fixture'},management)).status,200,'existing stock may retain an archived template');
assert(!(await call('inventory-locations','GET',{}, {...owner,organization_id:other})).locations.some(row=>String(row.id)===String(placeId)),'tenant location list excludes another tenant’s templates');
const listedLocations=(await call('inventory-locations','GET',{},management)).locations;assert(listedLocations.find(row=>String(row.id)===String(placeId)).item_count>=1,'place list returns usage count');
assert(!listedLocations.some(row=>String(row.id)===String(otherPlace.location.id)),'place list is tenant scoped');
assert.equal((await call('inventory-locations','POST',{name:'Z'},management)).status,400,'a place name needs two characters or more');
assert.equal((await call(`inventory-locations/${placeId}`,'PATCH',{name:'Z'},management)).status,400);
assert((await call('inventory-locations')).locations.find(row=>String(row.id)===String(placeId))?.name.length>=2,'the rejected rename keeps the stored place name');
const unused=(await call('inventory-locations','POST',{name:'Temporary location'},management)).location;
assert.equal((await call(`inventory-locations/${unused.id}`,'DELETE',{},management)).status,200,'unreferenced place can be deleted');
let templateReturn=(await call('inventory-reservations','POST',{...reservationPayload([created.id]),...currentRange},owner)).reservation;
templateReturn=(await call(`inventory-reservations/${templateReturn.id}/checkout`,'POST',{expected_version:templateReturn.version,custodian_user_id:producer.id},owner)).reservation;
const templateReturnResult=await call(`inventory-reservations/${templateReturn.id}/return`,'POST',{expected_version:templateReturn.version,locations:[{inventory_id:created.id,storage_location_id:created.storage_location_id,status:'available'}]},owner);
assert.equal(templateReturnResult.status,200,'returns accept an active reusable template without redundant shelf text');
const returnedTemplateRecord=(await call(`inventory/${created.id}`)).record;
assert.equal(String(returnedTemplateRecord.storage_location_id),String(created.storage_location_id));assert.equal(returnedTemplateRecord.storage_shelf,'Rack de audio');
assert.equal((await call('inventory-locations','GET',{},viewer)).status,200);
assert.equal((await call('inventory-locations','POST',{name:'Forbidden'},producer)).status,403);

// Un PATCH solo revalida el campo que llega: una fila legacy por encima de los
// límites actuales sigue editable sin perder lo guardado (regla de AGENTS).
const legacyCustodian=(await query("insert into users(email,password_hash) values('legacy-custodian@example.invalid','unused') returning id")).rows[0].id;
await query("insert into organization_members(organization_id,user_id,role,active) values($1,$2,'production',false)",[org,legacyCustodian]);
const legacyId=String((await query("insert into agency_inventory(organization_id,name,category,serial_number,custodian_user_id,value,currency,status,notes,storage_shelf,storage_row) values($1,$2,$3,$4,$5,0,'USD','available',$6,$7,'7') returning id",[org,'Equipo legacy '+'X'.repeat(180),'Categoría legacy '+'Y'.repeat(90),'S'+'9'.repeat(130),legacyCustodian,'N'.repeat(2400),'E'+'Z'.repeat(140)])).rows[0].id);
const legacyPatch=await call(`inventory/${legacyId}`,'PATCH',{storage_row:'9'},management);
assert.equal(legacyPatch.status,200,JSON.stringify(legacyPatch));
assert(legacyPatch.record.name.length>160,'a legacy over-limit name travels untouched');
assert.equal(legacyPatch.record.notes.length,2400,'legacy notes are preserved as stored');
assert.equal(legacyPatch.record.storage_shelf.length,141,'a legacy shelf is not revalidated');
assert.equal(legacyPatch.record.storage_row,'9','the field that arrives still applies');
assert.equal(String(legacyPatch.record.custodian_user_id),String(legacyCustodian),'a stored suspended custodian is preserved, not revalidated');
assert(legacyPatch.record.category===undefined||legacyPatch.record.category.length>80,'a legacy free-text category is not rewritten');
// Los campos que sí llegan siguen revalidándose.
assert.equal((await call(`inventory/${legacyId}`,'PATCH',{name:'X'})).status,400);
assert.equal((await call(`inventory/${legacyId}`,'PATCH',{serial_number:'S'.repeat(130)})).status,400,'an incoming serial still respects the limit');
assert.equal((await call(`inventory/${legacyId}`,'PATCH',{value:-5})).status,400);
assert.equal((await call(`inventory/${legacyId}`,'PATCH',{status:'reparado'})).status,400);
assert.equal((await call(`inventory/${legacyId}`,'PATCH',{custodian_user_id:'999999'})).status,400,'an incoming custodian must be an active member');
assert.equal((await call(`inventory/${legacyId}`,'PATCH',{inventory_code:'OTRO'})).status,409,'the inventory code stays stable');
assert.equal((await call(`inventory/${legacyId}`)).record.storage_row,'9','failed edits keep the stored row');

await pg.close();
console.log(`PASS: ${apiCases} API cases; category lifecycle, multi-unit/responsible workflow, conflict rollback, reschedule/cancel releases, physical availability, overdue handover, complete-return atomicity, safe rejection of partial/malformed returns, recorded locations, calendar year/midnight boundaries, tenant/role checks, GiST exclusion, unique checkout and audit. Concurrent API requests use a single-connection PGlite pool; real multi-connection PostgreSQL not run.`);
