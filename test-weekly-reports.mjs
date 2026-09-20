import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {weeklyReports,reportWeek} from './weekly-reports.js';

const pg=new PGlite();
await pg.exec(`create table organizations(id bigint primary key,active boolean default true);
 create table users(id bigint primary key);
 create table organization_members(organization_id bigint,user_id bigint,role text,active boolean default true,removed_at timestamptz);
 create table organization_person_identity(organization_id bigint,user_id bigint,full_name text,photo_url text,email text);
 create table agency_projects(id bigserial primary key,organization_id bigint,name text not null);
 create table agency_operation_audit(id bigserial primary key,organization_id bigint,table_name text not null,action text not null,actor text,ip text,before_state jsonb,after_state jsonb,created_at timestamptz not null default now());
 insert into organizations(id) values(1),(2);insert into users values(1),(2),(3);
 insert into organization_members(organization_id,user_id,role) values(1,1,'owner'),(1,2,'editor'),(2,3,'owner');
 insert into organization_person_identity values(1,1,'Dueño',null,'owner@example.invalid'),(1,2,'Colaborador',null,'editor@example.invalid'),(2,3,'Otra empresa',null,'other@example.invalid');
 insert into agency_projects(id,organization_id,name) values(101,1,'Tienda Norte'),(102,1,'Estudio'),(201,2,'Proyecto ajeno');`);
const migration=await fs.readFile(new URL('./migrations/20260911_weekly_reports.sql',import.meta.url),'utf8');
await pg.exec(migration);await pg.exec(migration);
// The declared table stays in the schema for historical rows; the API no longer
// reads or writes it. A leftover declaration must never appear in a response.
await pg.query("insert into agency_weekly_reports(organization_id,user_id,week_start,metrics,notes) values(1,2,'2026-09-07','{\"videos\":{\"planned\":5}}','Histórico')");
const query=(sql,args)=>pg.query(sql,args);
const db={connect:async()=>({query,release(){}})};
const owner={id:1,organization_id:1,role:'owner'},editor={id:2,organization_id:1,role:'editor'},other={id:3,organization_id:2,role:'owner'};
async function call({as=editor,method='GET',scope='own',week='2026-09-07',payload={},extra=''}={}){
 let response;assert.equal(await weeklyReports({req:{method},res:{},url:new URL(`https://test/api/agency/weekly-reports?week=${week}&scope=${scope}${extra}`),db,session:async()=>as,body:async()=>payload,send:(_,status,data)=>{response={status,...data};}}),true);return response;
}
assert.equal(reportWeek('2026-09-07'),'2026-09-07');
for(const value of ['2026-09-08','2026-02-30','bad',''])assert.throws(()=>reportWeek(value));
assert.equal((await call({as:null})).status,401);
assert.equal((await call({as:{...editor,organization_id:2}})).status,403);
assert.equal((await call({scope:'team'})).status,403);
assert.equal((await call({week:'bad'})).status,400);
assert.equal((await call({extra:'&userId=1'})).status,400);
for(const method of ['PUT','POST','DELETE','PATCH']){const blocked=await call({method,payload:{version:0,metrics:{}}});assert.equal(blocked.status,405,`${method} is no longer part of the weekly report surface`);}
let r=await call();
assert.equal(r.status,200);
assert.equal(typeof r.week,'string');assert.equal(r.scope,'own');
assert.deepEqual(Object.keys(r).sort(),['automatic','scope','status','week'],'the response only carries the automatic section');
assert.equal('records' in r,false,'the declared records surface is retired');
assert.equal('canEdit' in r,false,'the retired declared flags are gone');
assert.equal('canViewTeam' in r,false,'the retired declared flags are gone');
assert.equal('source' in r,false,'the declared source marker is gone');
assert.deepEqual(r.automatic,[]);
// Automatic counts derive from audit transitions: once per order, attributed to
// the transition actor, with system actors and other weeks excluded.
await pg.exec(`insert into agency_operation_audit(organization_id,table_name,action,actor,ip,before_state,after_state,created_at) values
 (1,'agency_work_orders','UPDATE','2','127.0.0.1','{"status":"review","id":10,"project_id":101}','{"status":"approved","id":10,"work_type":"video","project_id":101}','2026-09-08T12:00:00-03:00'),
 (1,'agency_work_orders','UPDATE','2','127.0.0.1','{"status":"review","id":10,"project_id":101}','{"status":"published","id":10,"work_type":"video","project_id":101}','2026-09-09T12:00:00-03:00'),
 (1,'agency_work_orders','UPDATE','system','127.0.0.1','{"status":"review","id":11}','{"status":"published","id":11,"work_type":"foto"}','2026-09-08T12:00:00-03:00'),
 (1,'agency_work_orders','UPDATE','2','127.0.0.1','{"status":"review","id":12,"project_id":101}','{"status":"approved","id":12,"work_type":"foto","project_id":101}','2026-08-31T12:00:00-03:00'),
 (1,'agency_work_orders','UPDATE','1','127.0.0.1','{"status":"review","id":13,"project_id":102}','{"status":"published","id":13,"project_id":102}','2026-09-08T12:00:00-03:00'),
 (1,'agency_work_orders','INSERT','2','127.0.0.1','{}','{"id":20,"status":"to_record","project_id":102}','2026-09-10T10:00:00-03:00'),
 (1,'agency_work_orders','UPDATE','2','127.0.0.1','{"id":20,"status":"to_record","project_id":102}','{"id":20,"status":"editing","project_id":102}','2026-09-10T11:00:00-03:00'),
 (1,'agency_work_orders','DELETE','2','127.0.0.1','{"id":21,"status":"editing","project_id":102}',null,'2026-09-11T12:00:00-03:00'),
 (1,'agency_work_orders','UPDATE','system','127.0.0.1','{"id":23,"status":"editing"}','{"id":23,"status":"review"}','2026-09-08T12:00:00-03:00'),
 (1,'agency_work_orders','UPDATE','2','127.0.0.1','{"id":24,"status":"editing","project_id":101}','{"id":24,"status":"review","project_id":101}','2026-08-30T12:00:00-03:00')`);
r=await call({as:editor});
assert.ok(Array.isArray(r.automatic),'automatic array present on GET');
assert.equal(r.automatic.length,1);assert.equal(String(r.automatic[0].user_id),'2','transition actor, not assignee');
assert.equal(r.automatic[0].counts.video,1,'double transition in one week counts exactly once');
assert.equal(r.automatic[0].counts.foto,0,'transitions from other weeks never count');
assert.equal(r.automatic[0].counts.untyped,0);assert.equal(r.automatic[0].actor_name,'Colaborador');
assert.equal(r.automatic[0].orders,3,'orders count once per order: insert+update on #20, delete of #21, plus the finished #10');
const editorProjects=r.automatic[0].projects;
assert.equal(editorProjects.length,2,'project breakdown groups finished and worked pieces per project');
const tienda=editorProjects.find(project=>project.project_id===101),estudio=editorProjects.find(project=>project.project_id===102);
assert.equal(tienda.count,1,'finished pieces of that actor in the project during the week');
assert.equal(tienda.project_name,'Tienda Norte','project name resolves through agency_projects');
assert.equal(tienda.orders,1,'orders worked in the project count distinct orders');
assert.equal(estudio.count,0,'no finished pieces for that project, but worked orders still appear');
assert.equal(estudio.orders,2,'orders #20 (insert+update) and #21 (delete) group under Estudio');
assert.equal(editorProjects[0].project_id,101,'projects sort by finished count descending');
assert.equal((await call({as:owner})).automatic.length,1,'own scope filters the owner to their own work');
const teamAutomatic=(await call({as:owner,scope:'team'})).automatic;
assert.equal(teamAutomatic.length,2,'team scope shares per-collaborator automatic counts');
const ownerEntry=teamAutomatic.find(entry=>String(entry.user_id)==='1');
assert.equal(ownerEntry.orders,1,'owner orders derive from their own operations only');
assert.equal(ownerEntry.actor_name,'Dueño');
assert.equal(Object.fromEntries(teamAutomatic.map(row=>[String(row.user_id),row]))['1'].counts.untyped,1,'orders without work_type count under untyped');
assert.equal(ownerEntry.projects.length,1,'own work groups only under the owner project');
assert.equal(ownerEntry.projects[0].project_id,102);assert.equal(ownerEntry.projects[0].count,1);assert.equal(ownerEntry.projects[0].project_name,'Estudio');
assert.equal((await call({as:editor})).automatic[0].projects.some(project=>project.project_id===201),false,'other tenants never leak their projects');
assert.equal((await call({week:'2026-09-14'})).automatic.length,0,'empty weeks fabricate nothing');
assert.equal((await call({as:owner,scope:'team'})).automatic.length,2,'the retired declaration never reappears in the automatic section');
// A revoked membership loses access to the automatic section too.
await pg.exec('update organization_members set active=false where organization_id=1 and user_id=2');
assert.equal((await call()).status,403,'a revoked membership loses the automatic section');
assert.equal((await call({method:'PUT',payload:{version:0,metrics:{}}})).status,405,'writes stay rejected before any membership work');
await pg.close();
console.log('PASS weekly automatic report: retired declared surface (PUT/records/canEdit/canViewTeam), 405 on writes, historical rows never served, audit-derived counts once per order, scoped ownership, project breakdown, tenant isolation');
