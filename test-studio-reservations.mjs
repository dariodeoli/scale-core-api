import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {identitySchema} from './scripts/test-identity-schema.mjs';
import {studioReservations,studioTimestamp} from './studio-reservations.js';

const pg=new PGlite();
await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
for(const name of ['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql','20260910_productivity.sql','20260910_currencies.sql','20260910_company_currency.sql'])await pg.exec(await fs.readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8'));
await identitySchema(pg);
const query=(sql,args)=>pg.query(sql,args);
const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
const other=(await query("insert into organizations(slug,name) values('studio-other','Other') returning id")).rows[0].id;
const users=[];
for(const [index,role] of ['owner','production','viewer','management','sales'].entries()){
 const id=(await query('insert into users(email,password_hash) values($1,$2) returning id',[`studio-${index}@example.invalid`,'unused'])).rows[0].id;
 await query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3)',[org,id,role]);users.push({id,role,organization_id:org});
}
const [owner,producer,viewer,manager,seller]=users;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[other,owner.id]);
const client=(await query("insert into agency_clients(organization_id,name) values($1,'Studio client') returning id",[org])).rows[0].id;
const project=(await query("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Launch film') returning id",[org,client])).rows[0].id;
const otherClient=(await query("insert into agency_clients(organization_id,name) values($1,'Other client') returning id",[other])).rows[0].id;
const otherProject=(await query("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Other project') returning id",[other,otherClient])).rows[0].id;
await pg.exec(await fs.readFile(new URL('./migrations/20260910_inventory_reservations.sql',import.meta.url),'utf8'));
const migration=await fs.readFile(new URL('./migrations/20260912_studio_reservations.sql',import.meta.url),'utf8');await pg.exec(migration);await pg.exec(migration);

let tail=Promise.resolve();
const db={connect:async()=>{let unlock;const prior=tail;tail=new Promise(resolve=>{unlock=resolve;});await prior;return {query,release(){unlock();}};}};
async function call(path,method='GET',payload={},user=owner){
 let result;const handled=await studioReservations({req:{method,socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://test/api/agency/'+path),db,session:async()=>user,body:async()=>payload,send:(_,status,data)=>{result={status,...data};}});
 assert(handled);return result;
}
const start='2026-09-15T13:00:00-03:00',end='2026-09-15T15:00:00-03:00',adjacentEnd='2026-09-15T17:00:00-03:00';
assert.equal((await call('studio-spaces','GET',{},null)).status,401);
assert.equal((await call('studio-spaces','POST',{name:'Set principal'},viewer)).status,403);
const space=(await call('studio-spaces','POST',{name:'Set principal',scenario:'Fondo nogal'})).space;
// Decisión de producto #25: production vuelve a studio.manage (reserva y espacios).
assert.equal((await call('studio-spaces','POST',{name:'Cabina'},producer)).status,201,'producción administra espacios con studio.manage');
assert.equal((await call('studio-context','GET',{},viewer)).members.length,0);
// Decisión de producto #18: reservar el estudio se gobierna con studio.manage.
const studioContext=await call('studio-context','GET',{},seller);
assert.equal(studioContext.can_reserve,true,'ventas con studio.manage puede reservar');
assert(studioContext.projects.some(row=>String(row.id)===String(project)));
const managerContext=await call('studio-context','GET',{},manager);
assert.equal(managerContext.can_reserve,true,'gerencia reserva el estudio igual que antes');
const producerContext=await call('studio-context','GET',{},producer);
assert.equal(producerContext.can_reserve,true,'producción reserva el estudio como antes de #18 (issue #25)');
assert(producerContext.members.some(row=>String(row.id)===String(producer.id)),'el contexto de reserva llega completo para producción');
assert(producerContext.projects.some(row=>String(row.id)===String(project)));
assert.throws(()=>studioTimestamp('2026-02-30T10:00:00Z'));
const payload={space_id:space.id,project_id:project,title:'Podcast de lanzamiento',production_type:'podcast',starts_at:start,ends_at:end,responsible_user_ids:[producer.id],notes:'Dos micrófonos'};
assert.equal((await call('studio-reservations','POST',{...payload,responsible_user_ids:[owner.id]},producer)).status,400,'producción debe incluirse entre los responsables de su reserva');
const productionReservation=(await call('studio-reservations','POST',payload,producer)).reservation;
assert.equal((await call('studio-reservations','POST',{...payload,title:'Overlap'},producer)).status,409,'el solape sigue bloqueado para producción');
assert.equal((await call(`studio-reservations/${productionReservation.id}/cancel`,'POST',{expected_version:productionReservation.version},producer)).reservation.status,'cancelled','producción cancela su propia reserva');
assert.equal((await call('studio-reservations','POST',{...payload,project_id:otherProject},seller)).status,400);
const reservation=(await call('studio-reservations','POST',payload,seller)).reservation;
assert.equal(reservation.space_name,'Set principal');assert.equal(reservation.responsible_members.length,1);assert.equal(reservation.project_name,'Launch film');
assert.equal((await call('studio-reservations','POST',{...payload,title:'Overlap'},seller)).status,409);
const second=(await call('studio-reservations','POST',{...payload,title:'Ads de tarde',production_type:'ads',starts_at:end,ends_at:adjacentEnd},seller)).reservation;
assert.equal(second.status,'reserved','adjacent bookings are allowed');
const concurrentSpace=(await call('studio-spaces','POST',{name:'Cabina podcast'})).space;
const concurrentPayload={...payload,space_id:concurrentSpace.id,title:'Concurrent fixture'};
const competing=await Promise.all([call('studio-reservations','POST',concurrentPayload,seller),call('studio-reservations','POST',concurrentPayload,seller)]);
assert.deepEqual(competing.map(result=>result.status).sort(),[201,409],'only one overlapping booking may commit');
assert.equal((await call(`studio-reservations/${reservation.id}`,'PATCH',{...payload,expected_version:99},seller)).status,409);
assert.equal((await call(`studio-reservations/${reservation.id}`,'PATCH',{...payload,expected_version:reservation.version,title:'Podcast editado'},viewer)).status,403);
assert.equal((await call(`studio-reservations/${reservation.id}/cancel`,'POST',{expected_version:reservation.version},seller)).reservation.status,'cancelled');
assert.equal((await call('studio-reservations','POST',{...payload,title:'Nueva toma'},seller)).status,201,'cancelled slots are available again');
assert.equal((await call(`studio-spaces/${space.id}`,'PATCH',{name:'Set principal',scenario:'Fondo negro',active:false},manager)).space.active,false);
assert.equal((await call('studio-reservations','POST',{...payload,space_id:space.id,title:'No new inactive space'},seller)).status,400);
assert.equal((await call(`studio-reservations/${second.id}`,'GET',{}, {...owner,organization_id:other})).status,404);
assert.equal((await query('select count(*)::int as count from agency_inventory_reservations')).rows[0].count,0,'studio bookings do not touch inventory reservations');
await pg.close();
console.log('PASS: studio spaces, tenant isolation, permissions (production, sales and management reserve; viewer cannot), optional project, responsible members, exclusion overlap and inventory separation');
