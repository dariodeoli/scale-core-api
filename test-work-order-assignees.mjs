// node --experimental-vm-modules --test test-invitation-full-flow-regression.mjs
// Based on the existing access-recovery VM harness; no runtime files or external services.
// Real handlers/local modules, clean committed schema, isolated PGlite; no sockets/providers.
import assert from 'node:assert/strict';
import {enrichWorkOrderAssignees} from './work-order-assignees.js';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
assert(vm.SourceTextModule,'Use --experimental-vm-modules');
const root=fileURLToPath(new URL('.',import.meta.url)),pg=new PGlite();
const source=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
await pg.exec(execFileSync('git',['show','HEAD:schema.sql'],{cwd:root,encoding:'utf8'}));
const init=source.slice(source.indexOf('async function init()'),source.indexOf('async function provisionOwner('));
const migrations=[...init.matchAll(/['"](?:migrations\/)?(\d{8}_[\w-]+\.sql)['"]/g)].map(m=>m[1]).filter(f=>f!=='20260908_dadoo_hub.sql');
for(const file of migrations)await pg.exec(await fs.readFile(new URL('./migrations/'+file,import.meta.url),'utf8'));
let rejectEnrichment=false;
const query=(s,v)=>{if(rejectEnrichment&&s.startsWith('with orders as'))throw Error('Fixture enrichment failure');return pg.query(s,v);},rows=async(s,v)=>(await query(s,v)).rows;
const insert=async(s,v)=>(await rows(s+' returning id',v))[0].id;
let handler,calls=0,providerCalls=0,mode='success';
const profile={email:'oauth-recovery@example.invalid',name:'OAuth Fixture',picture:'https://lh3.googleusercontent.com/fixture-photo',email_verified:true};
async function google(url){
 providerCalls++;
 assert(['https://oauth2.googleapis.com/token','https://openidconnect.googleapis.com/v1/userinfo'].includes(url),'No external resource is allowed');
 const token=url.endsWith('/token'),phase=token?'token':'profile';
 if(mode===phase+'-throw')throw Error('fixture provider failure, do not expose');
 return {ok:mode!==phase+'-http',json:async()=>{
  if(mode===phase+'-json')throw Error('fixture malformed JSON, do not expose');
  if(token)return mode==='token-missing'?{}:{access_token:'fixture-only'};
  return mode==='profile-null'?null:mode==='profile-unverified'?{...profile,email_verified:false}:mode==='profile-unverified-string'?{...profile,email_verified:'true'}:mode==='profile-no-email'?{email_verified:true}:profile;
 }};
}
const context=vm.createContext({console,URL,URLSearchParams,Buffer,AbortSignal,TextEncoder,TextDecoder,fetch:google,
 process:{env:{GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',STRIPE_BILLING_ENABLED:'false'}},
 setTimeout,clearTimeout,setInterval(){throw Error('No background services');},clearInterval});
const modules=new Map();
async function load(spec,ref){
 const key=spec.startsWith('.')?new URL(spec,ref.identifier).href:spec;if(modules.has(key))return modules.get(key);
 let m;if(key.startsWith('file:'))m=new vm.SourceTextModule(await fs.readFile(new URL(key),'utf8'),{context,identifier:key,initializeImportMeta(meta){meta.url=key;}});
 else{
  const exports=key==='node:http'?{default:{createServer(fn){handler=fn;return {listen(){}};}}}:key==='pg'?{default:{Pool:class{query=query;connect=async()=>({query,release(){}});}}}:await import(key);
  m=new vm.SyntheticModule(Object.keys(exports),function(){for(const k of Object.keys(exports))this.setExport(k,exports[k]);},{context,identifier:key});
 }
 modules.set(key,m);return m;
}
const server=await load('./server.js',{identifier:import.meta.url});await server.link(load);await server.evaluate();
async function request(path,{cookie='',method='GET',payload}={}){
 calls++;const r={status:0,headers:{},body:''};
 await handler({url:path,method,headers:{host:'untrusted.example.invalid',cookie},socket:{remoteAddress:'fixture'},async *[Symbol.asyncIterator](){if(payload!==undefined)yield JSON.stringify(payload);}},
 {setHeader(k,v){r.headers[k]=v;},writeHead(status,h){r.status=status;Object.assign(r.headers,h);},end(b){r.body=b||'';}});
 return {...r,data:JSON.parse(r.body||'{}')};
}


const org=await insert("insert into organizations(slug,name) values('cards-a','Cards A')");
const other=await insert("insert into organizations(slug,name) values('cards-b','Cards B')");
const people=[];
for(const [index,name] of ['Owner','Direct Person','Project Person','Other Person'].entries()){
 const uid=await insert("insert into users(email,password_hash) values($1,'unused')",['card'+index+'@example.invalid']);
 const tenant=index===3?other:org;
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[tenant,uid]);
 await query('insert into agency_user_profiles(organization_id,user_id,full_name,photo_url) values($1,$2,$3,$4)',[tenant,uid,name,'https://example.invalid/'+index+'.png']);
 people.push(uid);
}
const [owner,direct,projectPerson,outsider]=people;
const token='cards-test-session';
await query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '1 day')",[token,owner,org]);
const cookie='scale_session='+token;
const client=await insert("insert into agency_clients(organization_id,name) values($1,'Client')",[org]);
const project=await insert("insert into agency_projects(organization_id,client_id,name,assigned_user_id) values($1,$2,'Project',$3)",[org,client,projectPerson]);
const emptyProject=await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Empty')",[org,client]);
const foreignClient=await insert("insert into agency_clients(organization_id,name) values($1,'Foreign client')",[other]);
const foreignProject=await insert("insert into agency_projects(organization_id,client_id,name,assigned_user_id) values($1,$2,'Foreign project',$3)",[other,foreignClient,outsider]);
const order=await insert("insert into agency_work_orders(organization_id,project_id,title,assigned_user_id) values($1,$2,'Direct',$3)",[org,project,direct]);
const inherited=await insert("insert into agency_work_orders(organization_id,project_id,title) values($1,$2,'Project context')",[org,project]);
const empty=await insert("insert into agency_work_orders(organization_id,project_id,title,description) values($1,$2,'Other Person','Trello alias: Direct Person')",[org,emptyProject]);
const foreignOrder=await insert("insert into agency_work_orders(organization_id,project_id,title,assigned_user_id) values($1,$2,'Foreign piece',$3)",[other,foreignProject,outsider]);
await query('insert into agency_work_order_assignees(organization_id,work_order_id,user_id) values($1,$2,$3),($1,$2,$4)',[org,order,direct,owner]);
await query('insert into agency_project_assignees(organization_id,project_id,user_id) values($1,$2,$3)',[org,project,owner]);
const read=path=>request('/api/agency/'+path,{cookie});
const ids=rows=>rows.map(row=>row.id);
let r=await read('work-orders');assert.equal(r.status,200);
let card=r.data.workOrders.find(o=>o.id===order);
assert.equal(card.assignee_source,'direct');
assert.deepEqual(ids(card.assignees),[String(direct),String(owner)],'Primary first and duplicate primary is collapsed');
assert.equal(card.assignees[0].full_name,'Direct Person');assert.equal(card.assignees[0].photo_url,'https://example.invalid/1.png');
assert.equal(card.assignees[0].source,'direct');assert.equal(card.assignees[0].is_primary,true);
assert.deepEqual(ids(card.effective_assignees),ids(card.assignees));
assert.deepEqual(ids(card.project_assignees),[String(projectPerson),String(owner)]);
card=r.data.workOrders.find(o=>o.id===inherited);
assert.equal(card.assignee_source,'project');assert.deepEqual(card.assignees,[]);
assert.deepEqual(ids(card.effective_assignees),[String(projectPerson),String(owner)]);assert.equal(card.effective_assignees[0].source,'project');
assert.equal(card.assigned_user_id,null);assert.deepEqual(card.assigned_user_ids,[],'Inherited people never become stored direct IDs');
card=r.data.workOrders.find(o=>o.id===empty);assert.equal(card.assignee_source,null);assert.deepEqual(card.effective_assignees,[],'No guessing names or Trello aliases');
assert(!r.data.workOrders.some(o=>o.id===foreignOrder));
assert(!JSON.stringify(r.data).includes('Other Person.png'));

// List, detail, client dossier, assignment editor, and write response carry photos.
r=await read('work-orders/'+order);assert.equal(r.status,200);assert.equal(r.data.record.assignees[0].photo_url,'https://example.invalid/1.png');
r=await read('productivity/orders/'+order);assert.equal(r.status,200);assert.equal(r.data.order.assignees[0].full_name,'Direct Person');
r=await read('productivity/clients/'+client);assert.equal(r.status,200);assert.equal(r.data.orders.find(o=>o.id===inherited).assignee_source,'project');
r=await read('work-orders/'+order+'/assignees');assert.equal(r.status,200);assert.equal(r.data.assignees[0].photo_url,'https://example.invalid/1.png');
r=await read('projects/'+project+'/assignees');assert.equal(r.status,200);assert.equal(r.data.assignees[0].photo_url,'https://example.invalid/2.png');
r=await read('assignees');assert.equal(r.status,200);assert.equal(r.data.members.find(p=>p.id===String(direct)).photo_url,'https://example.invalid/1.png');
rejectEnrichment=true;
r=await request('/api/agency/work-orders',{cookie,method:'POST',payload:{title:'Created card',projectId:project}});
rejectEnrichment=false;
assert.equal(r.status,201);assert.equal(Object.hasOwn(r.data.workOrder,'assignees'),false,'Creation keeps its original response and cannot fail enrichment after commit');
assert.equal((await rows("select count(*)::int n from agency_work_orders where title='Created card'"))[0].n,1);
assert.equal((await read('work-orders/'+r.data.workOrder.id)).data.record.assignee_source,'project');
r=await request('/api/agency/work-orders/'+order,{cookie,method:'PATCH',payload:{title:'Edited card'}});
assert.equal(r.status,200);assert.equal(r.data.workOrder.assignees[0].full_name,'Direct Person');
rejectEnrichment=true;
r=await request('/api/agency/work-orders/'+order,{cookie,method:'PATCH',payload:{title:'Must roll back'}});
rejectEnrichment=false;
assert.equal(r.status,500);assert.equal((await rows('select title from agency_work_orders where id=$1',[order]))[0].title,'Edited card');
assert.equal((await request('/api/agency/work-orders')).status,401);
assert.equal((await read('work-orders/'+foreignOrder)).status,404);

// A whole batch is one SQL lookup, including repeated project assignees.
await query("insert into agency_work_orders(organization_id,project_id,title) select $1,$2,'Batch '||n from generate_series(1,100) n",[org,project]);
const batch=await rows('select * from agency_work_orders where organization_id=$1',[org]);let lookups=0;
await enrichWorkOrderAssignees({query:async(...args)=>{lookups++;return query(...args);}},org,batch);
assert.equal(lookups,1);assert(batch.length>100);assert.equal(batch.find(o=>o.title==='Batch 99').assignee_source,'project');
await enrichWorkOrderAssignees({query:async()=>{throw Error('Empty lists need no SQL');}},org,[]);
const mixed=[{id:foreignOrder}];await enrichWorkOrderAssignees({query},org,mixed);assert.deepEqual(mixed[0].effective_assignees,[],'Explicit tenant prevents cross-company identity disclosure');
await query("update agency_user_profiles set full_name='Changed name',photo_url=null where organization_id=$1 and user_id=$2",[org,direct]);
r=await read('work-orders');card=r.data.workOrders.find(o=>o.id===order);assert.equal(card.assignees[0].full_name,'Changed name');assert.equal(card.assignees[0].photo_url,null);
await query('update organization_members set active=false,removed_at=now() where organization_id=$1 and user_id=any($2::bigint[])',[org,[direct,projectPerson]]);
r=await read('work-orders');card=r.data.workOrders.find(o=>o.id===order);
assert.deepEqual(ids(card.assignees),[String(owner)]);assert.deepEqual(ids(card.project_assignees),[String(owner)]);
assert(!JSON.stringify(r.data.workOrders).includes('Changed name'));assert(!JSON.stringify(r.data.workOrders).includes('Project Person'));
await query("insert into agency_archived_records(organization_id,kind,record_id,removed_by) values($1,'projects',$2,$3)",[org,project,owner]);
r=await read('work-orders');assert(!r.data.workOrders.some(o=>o.project_id===project));
const hidden=[{id:order}];await enrichWorkOrderAssignees({query},org,hidden);assert.deepEqual(hidden[0].effective_assignees,[]);
await pg.close();
console.log('PASS: production list/detail/dossier/write identities, direct/project sources, legacy IDs, dedup/order, active scoped membership, archives, no alias guesses, batched >100 cards.');
