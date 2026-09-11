import assert from 'node:assert/strict';
import {identitySchema} from './scripts/test-identity-schema.mjs';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {presence} from './presence.js';
import {randomUUID} from 'node:crypto';
const pg=new PGlite();await pg.exec(await fs.readFile('schema.sql','utf8'));for(const f of ['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql','20260910_productivity.sql','20260910_presence.sql'])await pg.exec(await fs.readFile('migrations/'+f,'utf8'));
await identitySchema(pg);
const query=(s,v)=>pg.query(s,v),db={connect:async()=>({query,release(){}})};
const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
const uid=(await query("insert into users(email,password_hash) values('presence@example.invalid','unused') returning id")).rows[0].id;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,uid]);
const other=(await query("insert into organizations(slug,name) values('presence-other','Other') returning id")).rows[0].id;
const client=(await query("insert into agency_clients(organization_id,name) values($1,'Test') returning id",[org])).rows[0].id;
const project=(await query("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Test') returning id",[org,client])).rows[0].id;
const user={id:uid,organization_id:org,role:'owner'};let result;
const payload={tab_id:'12345678-1234-1234-1234-123456789abc',active:true,visible:true,project_id:String(project)};
async function call(path,method='GET',value=payload,as=user){await presence({req:{method},res:{},url:new URL('https://test/api/agency/presence/'+path),db,session:async()=>as,sessionKey:()=> 'session-test',body:async()=>value,send:(_,status,data)=>{result={status,...data};}});return result;}
assert.equal((await call('usage','GET',null,null)).status,401);assert.equal((await call('usage','GET',null,{...user,role:'admin'})).status,403);
assert.equal((await call('heartbeat','POST')).status,200);assert.equal((await call('heartbeat','POST')).status,200);
let usage=(await call('usage')).people[0];assert.equal(usage.sessions,1);assert.equal(usage.active_seconds,0);assert.equal(usage.online,true);
await query("update agency_usage_sessions set last_seen_at=now()-interval '30 seconds'");await call('heartbeat','POST');usage=(await call('usage')).people[0];assert(usage.active_seconds>=29&&usage.active_seconds<=31);
assert.equal((await call('project?projectId='+project)).people.length,1);
assert.equal((await call('project?projectId='+project,'GET',payload,{...user,organization_id:other})).status,404);
assert.equal((await call('usage','GET',null,{...user,organization_id:other})).people.length,0);
await call('heartbeat','POST',{...payload,visible:false,active:false});assert.equal((await call('project?projectId='+project)).people.length,0);
assert.equal((await call('usage?userId='+uid)).records.length,1);
await query("update agency_usage_sessions set last_seen_at=now()-interval '5 hours'");await call('heartbeat','POST');const after=(await call('usage')).people[0];assert.equal(after.active_seconds,usage.active_seconds);
await query("update agency_presence_tabs set last_seen_at=now()-interval '2 minutes'");assert.equal((await call('usage')).people[0].online,false);

// Two actual member records, multiple tabs, and a profile with a different photo
// in a second tenant. All fixtures live in the in-memory database above.
const secondUid=(await query("insert into users(email,password_hash) values('presence-second@example.invalid','unused') returning id")).rows[0].id;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'editor'),($3,$2,'editor')",[org,secondUid,other]);
await query("insert into agency_user_profiles(organization_id,user_id,full_name,photo_url) values($1,$2,'Ana Pérez','https://example.invalid/ana.png'),($1,$3,'Bruno Díaz',null),($4,$2,'Other name','https://example.invalid/other.png')",[org,uid,secondUid,other]);
const secondUser={id:secondUid,organization_id:org,role:'editor'};
const secondProject=(await query("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Second project') returning id",[org,client])).rows[0].id;
const otherClient=(await query("insert into agency_clients(organization_id,name) values($1,'Other client') returning id",[other])).rows[0].id;
const otherProject=(await query("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Other project') returning id",[other,otherClient])).rows[0].id;
const anaActive={...payload,tab_id:randomUUID()},anaIdle={...payload,tab_id:randomUUID(),active:false};
const brunoIdle={...payload,tab_id:randomUUID(),active:false};
await call('heartbeat','POST',anaActive);await call('heartbeat','POST',anaIdle);await call('heartbeat','POST',brunoIdle,secondUser);
await call('heartbeat','POST',{...anaIdle,tab_id:randomUUID(),project_id:String(secondProject)});
await call('heartbeat','POST',{...payload,tab_id:randomUUID(),project_id:String(otherProject)}, {...secondUser,organization_id:other});
let people=(await call('project?projectId='+project)).people;
assert.equal(people.length,2,'multiple tabs collapse to one person');
assert.deepEqual(people.map(p=>[String(p.id),p.name,p.photo_url,p.active]),[[String(uid),'Ana Pérez','https://example.invalid/ana.png',true],[String(secondUid),'Bruno Díaz',null,false]]);
assert.equal((await call('usage')).people.find(p=>String(p.id)===String(uid)).sessions,1,'several tabs remain one usage session');
const batch=()=>call('projects?ids='+[project,secondProject,project,otherProject].join(','));
let board=await batch();assert.equal(board.status,200,'batch must run against the current archive schema');
assert.equal(board.people.length,3,'one row per person/project and no foreign project');
assert.equal(board.people.filter(p=>String(p.id)===String(uid)).length,2);
assert.equal(board.people.find(p=>String(p.project_id)===String(secondProject)).active,false,'activity is per project, not per member');
assert(!JSON.stringify(board.people).includes('other.png'),'photo comes from the same organization');
assert((await call('projects?ids='+project,'GET',payload,{...user,organization_id:other})).people.length===0);
assert.equal((await call('projects?ids='+otherProject)).people.length,0);
assert.equal((await call('heartbeat','POST',{...payload,project_id:String(otherProject)})).status,404);
assert.equal((await call('projects?ids='+project,'GET',null,null)).status,401);
assert.equal((await call('projects?ids='+project,'POST')).status,405);

// Disabling/removing access removes their avatars immediately, even while tabs are recent.
await query('update organization_members set active=false where organization_id=$1 and user_id=$2',[org,secondUid]);
assert.equal((await call('project?projectId='+project)).people.length,1);assert.equal((await batch()).people.length,2);
await query('update organization_members set active=true,removed_at=now() where organization_id=$1 and user_id=$2',[org,secondUid]);
assert.equal((await call('project?projectId='+project)).people.length,1);assert.equal((await batch()).people.length,2);
await query('update organization_members set removed_at=null where organization_id=$1 and user_id=$2',[org,secondUid]);
// A stale active tab must not make another fresh idle tab appear active.
await query("update agency_presence_tabs set last_seen_at=now()-interval '76 seconds' where tab_id=$1",[anaActive.tab_id]);
assert.equal((await call('project?projectId='+project)).people.find(p=>String(p.id)===String(uid)).active,false);
assert.equal((await batch()).people.find(p=>String(p.id)===String(uid)&&String(p.project_id)===String(project)).active,false);
await call('heartbeat','POST',{...anaIdle,visible:false});
assert.equal((await call('project?projectId='+project)).people.length,1,'closing last fresh tab removes that person');
await query("update agency_presence_tabs set last_seen_at=now()-interval '76 seconds' where organization_id=$1",[org]);
assert.equal((await batch()).people.length,0,'all expired presence is absent');
await call('heartbeat','POST',anaIdle);
await query("insert into agency_archived_records(organization_id,kind,record_id,removed_by) values($1,'projects',$2,$3)",[org,project,uid]);
assert.equal((await call('projects?ids='+project)).people.length,0,'archived project hidden from batch');
assert.equal((await call('project?projectId='+project)).status,409);
await query("delete from agency_archived_records where organization_id=$1 and kind='projects'",[org]);
await query("insert into agency_archived_records(organization_id,kind,record_id,removed_by) values($1,'clients',$2,$3)",[org,client,uid]);
assert.equal((await call('projects?ids='+project)).people.length,0,'archived parent client also hides presence');
await query("delete from agency_archived_records where organization_id=$1 and kind='clients'",[org]);

for(const ids of ['', '0','-1','abc','1.5','1e2','1,,2',',1','1,','9223372036854775808','9'.repeat(100)]){
 assert.equal((await call('projects?ids='+ids)).status,400,'invalid batch ids should be 400, not a database error: '+ids);
}
assert.equal((await call('projects?ids='+Array(101).fill(project).join(','))).status,400,'cap applies before deduplication');
assert.equal((await call('projects?ids='+Array(100).fill(project).join(','))).status,200);
const atLimit=await call('projects?ids='+Array.from({length:100},(_,i)=>String(i+1)).join(','));assert.equal(atLimit.status,200);
// 20 people in one project, 2000 in the board are the existing response limits.
const extraUsers=(await query("insert into users(email,password_hash) select 'presence-extra-'||i||'@example.invalid','unused' from generate_series(1,21) i returning id")).rows;
for(const row of extraUsers){
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')",[org,row.id]);
 await query('insert into agency_presence_tabs(organization_id,user_id,tab_id,project_id) values($1,$2,$3,$4)',[org,row.id,randomUUID(),project]);
}
assert.equal((await call('project?projectId='+project)).people.length,20);
const projectIds=(await query("insert into agency_projects(organization_id,client_id,name) select $1,$2,'Batch limit '||i from generate_series(1,99) i returning id",[org,client])).rows.map(row=>row.id);
await query(`insert into agency_presence_tabs(organization_id,user_id,tab_id,project_id)
 select $1,u.id,md5(u.id::text||':'||p.id::text)::uuid,p.id from users u cross join agency_projects p
 where u.email like 'presence-extra-%' and p.id=any($2::bigint[])`,[org,projectIds]);
assert.equal((await call('projects?ids='+[project,...projectIds].join(','))).people.length,2000);
await pg.close();console.log('PASS: owner-only usage, two-user photos, per-project active state, multi-tab dedup, removed members, expiry, archived parents, tenant isolation and batch/input/output limits');
