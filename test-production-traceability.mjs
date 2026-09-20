import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {PGlite} from '@electric-sql/pglite';
import {identitySchema} from './scripts/test-identity-schema.mjs';
import {externalLink} from './media-policy.js';
import {visibleRecord} from './record-lifecycle.js';
import {normalizeUrgency} from './urgency.js';
import {roleCan} from './permissions.js';
import {ensurePersonalIdentity} from './identity-session.js';
import {weeklyReports} from './weekly-reports.js';

// Execute the real POST work-orders route body with the in-memory database.
// Never import server.js: that would open a port and initialize a configured
// database. Only the route slice and its helpers are extracted.
const source=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
const coreSource=await fs.readFile(new URL('./agency-core.js',import.meta.url),'utf8');
function betweenRoutes(start,end){
 const a=coreSource.indexOf(start),b=coreSource.indexOf(end,a+start.length);
 assert(a>=0&&b>a,`Core test anchor missing: ${start}`);
 assert.equal(coreSource.indexOf(start,a+start.length),-1,`Ambiguous anchor: ${start}`);
 return coreSource.slice(a,b);
}
function between(start,end){
 const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
 assert(a>=0&&b>a,`Server test anchor missing: ${start}`);
 assert.equal(source.indexOf(start,a+start.length),-1,`Ambiguous anchor: ${start}`);
 return source.slice(a,b);
}
const route=betweenRoutes("    if (url.pathname === '/api/agency/work-orders' && req.method === 'POST') {","    if (url.pathname === '/api/agency/members' && req.method === 'GET') {");
const helpers=between('const send =','const cookie =')+between('const parseCookies =','const id =')+between('const sessionCache =','async function session(req) {')+between('async function session(req) {','async function auditContext(')+between('async function auditContext(','function security(');

const pg=new PGlite();
await pg.exec(await fs.readFile('schema.sql','utf8'));
for(const name of ['20260908_treasury_ledger','20260908_people_commissions_comments','20260908_operations_complete',
 '20260908_referral_discounts','20260908_collaborator_profiles','20260908_agency_suite','20260908_daily_controls',
 '20260910_work_checklists','20260910_company_currency','20260912_urgency','20260913_ruc_collaboration','20260911_weekly_reports'])await pg.exec(await fs.readFile(`migrations/${name}.sql`,'utf8'));
await identitySchema(pg);
for(const name of ['20260910_notifications','20260912_comment_mentions','20260914_production_traceability'])await pg.exec(await fs.readFile(`migrations/${name}.sql`,'utf8'));
await pg.exec(await fs.readFile('migrations/20260911_weekly_reports.sql','utf8'));
const query=(sql,args)=>pg.query(sql,args),db={query,connect:async()=>({query,release(){}})};
const insert=async(sql,args)=>(await query(sql+' returning id',args)).rows[0].id;
const postOrder=new Function('db','crypto','externalLink','visibleRecord','normalizeUrgency','roleCan','ensurePersonalIdentity',`${helpers}
 return async function(req,res){const url=new URL(req.url,'https://test.invalid');${route}
  throw new Error('Unexpected route in traceability test');};`)(db,crypto,externalLink,visibleRecord,normalizeUrgency,roleCan,ensurePersonalIdentity);

const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
const other=await insert("insert into organizations(slug,name) values('trace-other','Other')");
const owner=await insert("insert into users(email,password_hash) values('trace-owner@example.invalid','unused')");
const editor=await insert("insert into users(email,password_hash) values('trace-editor@example.invalid','unused')");
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner'),($1,$3,'editor')",[org,owner,editor]);
await query("insert into agency_user_profiles(organization_id,user_id,full_name) values($1,$2,'Dueño'),($1,$3,'Editora')",[org,owner,editor]);
const ownerToken='trace-owner-session-token';
await query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '1 hour')",[ownerToken,owner,org]);
const client=await insert("insert into agency_clients(organization_id,name) values($1,'Client')",[org]);
const project=await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Project')",[org,client]);

// TR-1 / TR-3: creation accepts work_type and due_time and persists both.
async function createOrder(payload){
 let result;
 const req=Readable.from([JSON.stringify(payload)]);req.method='POST';req.url='/api/agency/work-orders';req.headers={cookie:`scale_session=${ownerToken}`};req.socket={remoteAddress:'127.0.0.1'};
 await postOrder(req,{writeHead(status){result={status};},end(content){result={...result,...JSON.parse(content)};}});
 return result;
}
const created=await createOrder({title:'Video institucional',projectId:project,work_type:'video',due_time:'14:30'});
assert.equal(created.status,201,JSON.stringify(created));
assert.equal(created.workOrder.work_type,'video','work_type persists at creation');
assert.equal(created.workOrder.due_time,'14:30:00','due_time persists at creation (time column reads back HH:MM:SS)');
assert.equal((await createOrder({title:'Roto',projectId:project,due_time:'14:30:00'})).status,201,'round-tripped HH:MM:SS input is accepted');
const untyped=await createOrder({title:'Foto de producto',projectId:project});
assert.equal(untyped.status,201);assert.equal(untyped.workOrder.work_type,null,'missing type tolerated');
assert.equal((await createOrder({title:'Roto',projectId:project,work_type:'banner'})).status,400,'unknown work_type rejected');
assert.equal((await createOrder({title:'Roto',projectId:project,due_time:'25:99'})).status,400,'invalid due_time rejected');

// AR-1 / AR-2: automatic counts derive from audit transitions, once per order,
// attributed to the transition actor; system actors and other weeks are excluded.
function localWeek(){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Asuncion',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(new Date());
 const map=Object.fromEntries(parts.map(p=>[p.type,p.value]));
 const date=new Date(Date.UTC(Number(map.year),Number(map.month)-1,Number(map.day)));
 date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));
 return date.toISOString().slice(0,10);
}
const week=localWeek();
const audit=async(orderId,{actor,workType,status,daysAgo=0})=>{
 await query(`insert into agency_operation_audit(organization_id,table_name,action,actor,ip,before_state,after_state,created_at)
  values($1,'agency_work_orders','UPDATE',$2,'127.0.0.1',jsonb_build_object('status','review','id',$3::bigint),
  jsonb_build_object('status',$4::text,'id',$3::bigint,'work_type',$5::text),now()-$6::int * interval '1 day')`,[org,String(actor),orderId,status,workType,daysAgo]);
};
await audit(created.workOrder.id,{actor:owner,workType:'video',status:'approved'});
await audit(untyped.workOrder.id,{actor:editor,workType:null,status:'published'});
// Double transition in the same week: an order counts exactly once.
await audit(created.workOrder.id,{actor:editor,workType:'video',status:'published'});
// Non-numeric/system actors never count.
await audit(untyped.workOrder.id,{actor:'system',workType:'video',status:'published'});
// Week bucketing: an order whose first finished transition happened last week
// belongs to that week's report and never reappears.
const stale=await createOrder({title:'Entrega pasada',projectId:project,work_type:'foto'});
await audit(stale.workOrder.id,{actor:owner,workType:'foto',status:'approved',daysAgo:8});
const foreignProject=await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Foreign project')",[other,await insert("insert into agency_clients(organization_id,name) values($1,'Foreign client')",[other])]);
const foreignOrder=await insert("insert into agency_work_orders(organization_id,project_id,title) values($1,$2,'Foreign piece')",[other,foreignProject]);
await query(`insert into agency_operation_audit(organization_id,table_name,action,actor,ip,before_state,after_state,created_at)
 values($1,'agency_work_orders','UPDATE','999','127.0.0.1',jsonb_build_object('status','review'),jsonb_build_object('id',$2::bigint,'status','approved','work_type','produccion'),now())`,[other,foreignOrder]);

async function weekly(as,scope='team'){
 let response;
 assert.equal(await weeklyReports({req:{method:'GET'},res:{},url:new URL(`https://test/api/agency/weekly-reports?week=${week}&scope=${scope}`),db,session:async()=>as,body:async()=>{},send:(_,status,data,headers={})=>{response={status,...data,headers};}}),true);
 return response;
}
const team=await weekly({id:owner,organization_id:org,role:'owner'});
assert.equal(team.status,200);
assert.ok(Array.isArray(team.automatic),'automatic array present');
assert.equal(team.automatic.length,2,'one row per collaborator with finished transitions');
const byUser=Object.fromEntries(team.automatic.map(row=>[String(row.user_id),row]));
assert.equal(byUser[String(owner)].counts.video,1,'video counted once for the transition actor');
assert.equal(byUser[String(owner)].counts.untyped,0);
assert.equal(byUser[String(editor)].counts.untyped,1,'untyped order counted under its own category');
assert.equal(byUser[String(editor)].counts.video,0,'second transition of the same order never double-counts');
assert.equal(byUser[String(owner)].actor_name,'Dueño','actor identity resolved');
assert.equal('records' in team,false,'the declared weekly surface is retired: only the automatic section is served');
const own=await weekly({id:editor,organization_id:org,role:'editor'},'own');
assert.equal(own.status,200);
assert.equal(own.automatic.length,1,'own scope filters to the requesting collaborator');
assert.equal(own.automatic[0].counts.untyped,1);
assert.equal((await weekly({id:owner,organization_id:other,role:'owner'})).status,403,'other tenant rejected');

await pg.close();
console.log('PASS: creation persists work_type and due_time, audit-derived automatic counts attribute once per order to the transition actor, exclude system actors and other weeks, and stay tenant-scoped');
