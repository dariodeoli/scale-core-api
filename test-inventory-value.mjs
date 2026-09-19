// Purchase value, computed depreciation and the append-only maintenance log.
// Real migrations on PGlite; no external services or production data.
import assert from 'node:assert/strict';
import {identitySchema} from './scripts/test-identity-schema.mjs';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {inventoryReservations} from './inventory-reservations.js';

const pg=new PGlite();await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
for(const name of ['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql','20260910_currencies.sql','20260910_company_currency.sql'])await pg.exec(await fs.readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8'));
await identitySchema(pg);
for(const name of ['20260910_inventory_reservations.sql','20260912_inventory_verifications.sql','20260913_inventory_advanced_traceability.sql','20260914_inventory_storage_locations.sql','20260915_inventory_location_pipeline.sql','20260915_inventory_photos.sql','20260915_inventory_category_icons.sql','20260919_inventory_value_maintenance.sql']){
 const migration=await fs.readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8');
 await pg.exec(migration);await pg.exec(migration);
}
const query=(sql,args)=>pg.query(sql,args);
const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
const other=(await query("insert into organizations(slug,name) values('value-other','Other') returning id")).rows[0].id;
const users=[];
for(const [index,role] of ['owner','production','viewer','finance'].entries()){
 const id=(await query('insert into users(email,password_hash) values($1,$2) returning id',[`value-${role}${index}@example.invalid`,'unused'])).rows[0].id;
 await query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3)',[org,id,role]);users.push({id,role,organization_id:org});
}
const [owner,producer,viewer,finance]=users;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[other,owner.id]);
let tail=Promise.resolve();
const db={connect:async()=>{let unlock;const prior=tail;tail=new Promise(resolve=>{unlock=resolve;});await prior;return {query,release(){unlock();}};}};
async function call(path,method='GET',payload={},user=owner){
 let result;const handled=await inventoryReservations({req:{method,socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://test/api/agency/'+path),db,session:async()=>user,body:async()=>payload,send:(_,status,data)=>{result={status,...data};}});
 assert(handled,`${method} ${path} is handled`);return result;
}
const firstOfMonthsAgo=months=>{const now=new Date();return new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-months,1)).toISOString().slice(0,10);};

// The migration is re-runnable with data present: a second pass found the columns.
assert((await query("select column_name from information_schema.columns where table_name='agency_inventory' and column_name in ('purchase_value','purchase_date','depreciation_method','useful_life_months','residual_value')")).rows.length===5);
assert((await query("select to_regclass('agency_inventory_maintenance')::text as name")).rows[0].name==='agency_inventory_maintenance');

// Linear depreciation: half of a 12-month life elapsed, computed on read.
let item=(await call('inventory','POST',{name:'Cámara depreciable',purchase_value:1200.50,purchase_date:firstOfMonthsAgo(6),depreciation_method:'linear',useful_life_months:12,residual_value:0,currency:'USD'},producer)).record;
assert.equal(item.purchase_value,'1200.50');
assert.equal(item.depreciation_method,'linear');
assert.equal(item.useful_life_months,12);
assert.equal(item.current_value,'600.25','half of the purchase value');
assert.equal(item.accumulated_depreciation,'600.25');
assert.equal(item.monthly_depreciation,'100.04');
const untouched=(await query('select value,status,custodian_user_id,last_verified_at from agency_inventory where id=$1',[item.id])).rows[0];
assert.equal(Number(untouched.value),0,'depreciation never rewrites the legacy value');
assert.equal(untouched.status,'available');assert.equal(untouched.custodian_user_id,null);assert.equal(untouched.last_verified_at,null);

// No method: current equals the purchase value and nothing accumulates.
const flat=(await call('inventory','POST',{name:'Sin depreciación',purchase_value:500,currency:'USD'},producer)).record;
assert.equal(flat.current_value,'500.00');assert.equal(flat.accumulated_depreciation,'0.00');assert.equal(flat.monthly_depreciation,null);

// Life fully consumed: the residual value is the floor.
const residual=(await call('inventory','POST',{name:'Con residual',purchase_value:1000,purchase_date:firstOfMonthsAgo(24),depreciation_method:'linear',useful_life_months:10,residual_value:200,currency:'USD'},producer)).record;
assert.equal(residual.accumulated_depreciation,'800.00');assert.equal(residual.current_value,'200.00','never depreciates below the residual value');

// No purchase value registered: no invented current value.
const unknown=(await call('inventory','POST',{name:'Sin valor'},producer)).record;
assert.equal(unknown.current_value,null);assert.equal(unknown.accumulated_depreciation,null);assert.equal(unknown.monthly_depreciation,null);

// Server-side validations for the depreciation inputs.
for(const payload of [
 {purchase_value:100,residual_value:150},
 {residual_value:10},
 {purchase_value:100,depreciation_method:'linear',useful_life_months:0,purchase_date:firstOfMonthsAgo(1)},
 {purchase_value:100,depreciation_method:'linear',useful_life_months:601,purchase_date:firstOfMonthsAgo(1)},
 {purchase_value:100,depreciation_method:'doble-saldo'},
 {purchase_value:100,depreciation_method:'linear',useful_life_months:12},
 {purchase_value:-5},
 {purchase_value:'no-es-número'},
])assert.equal((await call('inventory','POST',{name:'Inválido',...payload},producer)).status,400,JSON.stringify(payload));
for(const role of [viewer])assert.equal((await call('inventory','POST',{name:'Viewer write',purchase_value:10},{...owner,role})).status,403);
assert.equal((await call(`inventory/${item.id}`,'GET',{},viewer)).status,200,'viewers still read the computed value');

// PATCH only changes the fields received and recomputes on read.
item=(await call(`inventory/${item.id}`,'PATCH',{useful_life_months:6},producer)).record;
assert.equal(item.current_value,'0.00','six months into a six-month life is fully depreciated');
assert.equal(item.accumulated_depreciation,'1200.50','the accumulated cap is the depreciable base');

// Maintenance log: create, list, edit, void. Nothing is hard-deleted.
let log=(await call('inventory-maintenance','POST',{inventory_id:item.id,maintenance_date:'2026-09-10',kind:'Service',description:'Cambio de obturador',cost:150.25,currency:'USD',responsible_user_id:producer.id},finance)).maintenance;
assert.equal(log.kind,'Service');assert.equal(log.cost,'150.25');assert.equal(log.currency,'USD');assert.equal(log.voided_at,null);
log=(await call(`inventory-maintenance/${log.id}`,'PATCH',{cost:200,description:'Cambio de obturador y limpieza'},finance)).maintenance;
assert.equal(log.cost,'200.00');
const listed=(await call(`inventory-maintenance?inventory_id=${item.id}`)).maintenance;
assert.equal(listed.length,1);assert.equal(listed[0].id,log.id);assert.equal(listed[0].inventory_code,item.inventory_code);
const detail=await call(`inventory/${item.id}`);
assert.equal(detail.maintenance.length,1,'the detail view carries the maintenance list');
let voided=await call(`inventory-maintenance/${log.id}`,'DELETE',{},finance);
assert.equal(voided.status,200);assert.equal(voided.ok,true);
const afterVoid=(await call(`inventory-maintenance?inventory_id=${item.id}`)).maintenance;
assert.ok(afterVoid[0].voided_at,'voided rows stay in history');
assert.equal((await call(`inventory-maintenance/${log.id}`,'DELETE',{},finance)).status,409,'a voided row cannot be voided twice');
assert.equal((await call(`inventory-maintenance/${log.id}`,'PATCH',{cost:1},finance)).status,409,'a voided row cannot be edited');

// Invalid maintenance payloads and role/tenant boundaries.
const base={inventory_id:item.id,maintenance_date:'2026-09-10',kind:'Service'};
assert.equal((await call('inventory-maintenance','POST',{...base,cost:-1},finance)).status,400);
assert.equal((await call('inventory-maintenance','POST',{...base,currency:'GBP'},finance)).status,400);
assert.equal((await call('inventory-maintenance','POST',{...base,kind:'x'},finance)).status,400);
assert.equal((await call('inventory-maintenance','POST',{...base,maintenance_date:'2026-02-30'},finance)).status,400);
assert.equal((await call('inventory-maintenance','POST',{...base,responsible_user_id:'999999'},finance)).status,400,'the responsible must be an active member');
assert.equal((await call('inventory-maintenance','POST',{...base},viewer)).status,403);
assert.equal((await call(`inventory-maintenance/${log.id}`,'DELETE',{},viewer)).status,403);
assert.equal((await call('inventory-maintenance','POST',{...base,inventory_id:'999999'},finance)).status,400,'the inventory item must belong to the company');
const crossTenant=await call('inventory-maintenance','POST',{...base},{...owner,organization_id:other});
assert.equal(crossTenant.status,400,'cross-tenant inventory ids never resolve');
assert.equal((await call('inventory-maintenance','GET',{}, {...owner,organization_id:other})).maintenance.length,0,'maintenance history is tenant-scoped');

assert.equal((await call(`inventory-maintenance/${log.id}`,'PATCH',{cost:1},{...owner,organization_id:other})).status,404,'a foreign maintenance row is not editable');
await pg.close();console.log('PASS: inventory value, linear depreciation caps, maintenance log with audit/void, validation and tenant isolation');
