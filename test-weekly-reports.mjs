import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {weeklyReports,declaration,reportWeek} from './weekly-reports.js';

const pg=new PGlite();
await pg.exec(`create table organizations(id bigint primary key,active boolean default true);
 create table users(id bigint primary key);
 create table organization_members(organization_id bigint,user_id bigint,role text,active boolean default true,removed_at timestamptz);
 create table organization_person_identity(organization_id bigint,user_id bigint,full_name text,photo_url text,email text);
 create table agency_operation_audit(id bigserial primary key,organization_id bigint,table_name text not null,action text not null,actor text,ip text,before_state jsonb,after_state jsonb,created_at timestamptz not null default now());
 insert into organizations(id) values(1),(2);insert into users values(1),(2),(3);
 insert into organization_members(organization_id,user_id,role) values(1,1,'owner'),(1,2,'editor'),(2,3,'owner');
 insert into organization_person_identity values(1,1,'Dueño',null,'owner@example.invalid'),(1,2,'Colaborador',null,'editor@example.invalid'),(2,3,'Otra empresa',null,'other@example.invalid');`);
const migration=await fs.readFile(new URL('./migrations/20260911_weekly_reports.sql',import.meta.url),'utf8');
await pg.exec(migration);await pg.exec(migration);
let failAttribution=false;const seen=[];
const query=async(sql,args)=>{seen.push(sql);if(failAttribution&&sql.startsWith('select user_id,full_name'))throw Error('identity unavailable');return pg.query(sql,args);};
const db={connect:async()=>({query,release(){}})};
const owner={id:1,organization_id:1,role:'owner'},editor={id:2,organization_id:1,role:'editor'},other={id:3,organization_id:2,role:'owner'};
const input={version:0,metrics:{videos:{completed:0,in_progress:null,planned:5},raw_clips:113,production_days:3,declared_hours:null},notes:'Datos de prueba únicamente'};
async function call({as=editor,method='GET',scope='own',week='2026-09-07',payload=input,extra=''}={}){
 let response;assert.equal(await weeklyReports({req:{method},res:{},url:new URL(`https://test/api/agency/weekly-reports?week=${week}&scope=${scope}${extra}`),db,session:async()=>as,body:async()=>payload,send:(_,status,data)=>{response={status,...data};}}),true);return response;
}
assert.equal(reportWeek('2026-09-07'),'2026-09-07');
for(const value of ['2026-09-08','2026-02-30','bad',''])assert.throws(()=>reportWeek(value));
const normalized=declaration(input);assert.equal(normalized.metrics.videos.completed,0);assert.equal(normalized.metrics.videos.planned,5);assert.equal(normalized.metrics.declared_hours,null);assert.equal(normalized.metrics.re_edits.completed,null);
for(const metrics of [{raw_clips:-1},{production_days:8},{declared_hours:169},{declared_hours:true},{raw_clips:'113'},{videos:{completed:1.5}},{videos:{estimated:5}}])assert.throws(()=>declaration({version:0,metrics}));
assert.throws(()=>declaration({...input,user_id:1}));
assert.equal((await call({as:null})).status,401);
assert.equal((await call({as:{...editor,organization_id:2}})).status,403);
assert.equal((await call({scope:'team'})).status,403);
assert.equal((await call({as:{...owner,role:'viewer'},method:'PUT'})).status,403);
assert.equal((await call({as:{...owner,role:'viewer'}})).canEdit,false);
assert.equal((await call({as:{...owner,role:'viewer'},scope:'team'})).status,403);
assert.equal((await call({method:'PUT',extra:'&userId=1'})).status,400);
assert.equal((await call({method:'DELETE'})).status,405);
assert.equal((await call()).records.length,0);
let r=await call({method:'PUT'});assert.equal(r.status,200);assert.equal(r.source,'declared');assert.equal(r.records[0].version,1);assert.equal(r.records[0].actor_name,'Colaborador');
assert.equal(r.records[0].metrics.videos.planned,5);assert.equal(r.records[0].metrics.videos.completed,0);assert.equal(r.records[0].metrics.raw_clips,113);assert.equal(r.records[0].metrics.declared_hours,null);
assert(seen.some(s=>s.includes('for share of m,o')));
assert.equal((await call({method:'PUT'})).status,409);
assert.equal((await call({as:owner})).records.length,0);
assert.equal((await call({as:owner,scope:'team'})).records.length,1);
assert.equal((await call({as:other,scope:'team'})).records.length,0);
assert.equal((await call({week:'2026-09-14'})).records.length,0);
// Automatic counts derive from audit transitions: once per order, attributed to
// the transition actor, with system actors and other weeks excluded. The
// declared PUT flow (versioning and 409) stays unchanged.
await pg.exec(`insert into agency_operation_audit(organization_id,table_name,action,actor,ip,before_state,after_state,created_at) values
 (1,'agency_work_orders','UPDATE','2','127.0.0.1','{"status":"review","id":10}','{"status":"approved","id":10,"work_type":"video"}','2026-09-08T12:00:00-03:00'),
 (1,'agency_work_orders','UPDATE','2','127.0.0.1','{"status":"review","id":10}','{"status":"published","id":10,"work_type":"video"}','2026-09-09T12:00:00-03:00'),
 (1,'agency_work_orders','UPDATE','system','127.0.0.1','{"status":"review","id":11}','{"status":"published","id":11,"work_type":"foto"}','2026-09-08T12:00:00-03:00'),
 (1,'agency_work_orders','UPDATE','2','127.0.0.1','{"status":"review","id":12}','{"status":"approved","id":12,"work_type":"foto"}','2026-08-31T12:00:00-03:00'),
 (1,'agency_work_orders','UPDATE','1','127.0.0.1','{"status":"review","id":13}','{"status":"published","id":13}','2026-09-08T12:00:00-03:00')`);
r=await call({as:editor});
assert.equal(r.records.length,1);assert.ok(Array.isArray(r.automatic),'automatic array present on GET');
assert.equal(r.automatic.length,1);assert.equal(String(r.automatic[0].user_id),'2','transition actor, not assignee');
assert.equal(r.automatic[0].counts.video,1,'double transition in one week counts exactly once');
assert.equal(r.automatic[0].counts.foto,0,'transitions from other weeks never count');
assert.equal(r.automatic[0].counts.untyped,0);assert.equal(r.automatic[0].actor_name,'Colaborador');
const teamAutomatic=(await call({as:owner,scope:'team'})).automatic;
assert.equal(teamAutomatic.length,2,'team scope shares per-collaborator automatic counts');
assert.equal(Object.fromEntries(teamAutomatic.map(row=>[String(row.user_id),row]))['1'].counts.untyped,1,'orders without work_type count under untyped');
r=await call({method:'PUT'});assert.equal(r.status,409,'stale declared update still conflicts');
assert.equal((await call()).automatic.length,1,'PUT conflicts never disturb the automatic section');
failAttribution=true;
assert.equal((await call({method:'PUT',payload:{...input,version:1,notes:'Must roll back'}})).status,500);
failAttribution=false;
r=await call();assert.equal(r.records[0].version,1);assert.equal(r.records[0].notes,input.notes);
assert.equal((await call({method:'PUT',payload:{...input,version:1,metrics:{declared_hours:6}}})).status,200);
r=await call();assert.equal(r.records[0].version,2);assert.equal(r.records[0].metrics.declared_hours,6);assert.equal(r.records[0].metrics.videos.completed,null);
await pg.exec('update organization_members set active=false where organization_id=1 and user_id=2');
assert.equal((await call({method:'PUT',payload:{...input,version:2}})).status,403);
await pg.close();
console.log('PASS weekly declarations: null vs zero, separate planned/raw counts, scoped ownership, effective role, optimistic concurrency, attribution rollback and membership lock');
