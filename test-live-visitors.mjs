import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {liveVisitors,purgeLiveVisitors,startLiveVisitorCleanup} from './live-visitors.js';

const pg=new PGlite();
await pg.exec(await fs.readFile('schema.sql','utf8'));
await pg.exec(await fs.readFile('migrations/20260910_demo_sessions.sql','utf8'));
const migration=await fs.readFile('migrations/20260910_live_visitors.sql','utf8');
await pg.exec(migration);await pg.exec(migration);
const query=(sql,values)=>pg.query(sql,values);
const db={query,connect:async()=>({query,release(){}})};
const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
const other=(await query("insert into organizations(slug,name) values('visitor-other','Other') returning id")).rows[0].id;
const uid=(await query("insert into users(email,password_hash) values('visitor-test@example.invalid','unused') returning id")).rows[0].id;
const demo=(await query("insert into organizations(slug,name,demo_owner_user_id,demo_expires_at) values('visitor-demo','Demo',$1,now()+interval '1 day') returning id",[uid])).rows[0].id;
const owner={id:uid,organization_id:org,organization_slug:'scale',role:'owner'};
const id=randomUUID(),payload={site:'scale-os-landing',session_id:id};
const headers={host:'admin.scaleparaguay.com',origin:'https://sistema.scaleparaguay.com','content-type':'application/json'};
async function call({path='/api/public/live-visitors/heartbeat',method='POST',value=payload,as=owner,extraHeaders={},raw}={}){
 const req=Readable.from([raw??JSON.stringify(value)]);req.method=method;req.headers={...headers,...extraHeaders};let result;
 const handled=await liveVisitors({req,res:{},url:new URL('https://admin.scaleparaguay.com'+path),db,session:async()=>as,send:(_,status,data,headers)=>{result={status,data,headers};}});
 return {handled,...result};
}
const counts=(as=owner,options={})=>call({path:'/api/agency/live-visitors',method:'GET',as,...options});
const n=async()=>Number((await query('select count(*) as n from live_visitor_sessions')).rows[0].n);
assert.equal((await call({path:'/unrelated'})).handled,false);
assert.equal((await counts(null)).status,401);
for(const role of ['management','finance','sales','production','editor','viewer'])assert.equal((await counts({...owner,role})).status,403);
assert.equal((await counts({...owner,role:'admin'})).status,200);
assert.equal((await counts(owner,{extraHeaders:{origin:undefined}})).status,200);
assert.equal((await counts(owner,{extraHeaders:{origin:'https://evil.example'}})).status,403);
assert.equal((await counts(owner,{extraHeaders:{'sec-fetch-site':'cross-site'}})).status,403);
assert.equal((await counts(owner,{extraHeaders:{host:'evil.example'}})).status,403);
assert.equal((await counts(owner,{path:'/api/agency/live-visitors?organization_id='+other})).status,400);
assert.equal((await counts(owner,{method:'POST'})).status,405);
assert.equal((await call({method:'GET'})).status,405);
for(const origin of [undefined,'null','https://evil.example','https://sistema.scaleparaguay.com.evil.example','http://sistema.scaleparaguay.com','https://sistema.scaleparaguay.com/','https://scaleparaguay.com'])assert.equal((await call({extraHeaders:{origin}})).status,403);
assert.equal((await call({extraHeaders:{host:'evil.example','x-forwarded-host':'admin.scaleparaguay.com'}})).status,403);
assert.equal((await call({value:{...payload,site:'unknown'}})).status,403);
for(const value of [null,[],{...payload,organization_id:other},{...payload,visible:false},{...payload,session_id:'IP-1.2.3.4'},{site:payload.site},{...payload,session_id:id.toUpperCase()}])assert.equal((await call({value})).status,400);
assert.equal((await call({raw:'{' })).status,400);
assert.equal((await call({raw:'x'.repeat(257)})).status,413);
assert.equal((await call({extraHeaders:{'content-length':'1000000'}})).status,413);
assert.equal((await call({extraHeaders:{'content-type':'text/plain'}})).status,415);
assert.equal(await n(),0,'rejections never insert visitors');

let result=await call();assert.equal(result.status,202);assert.deepEqual(result.data,{ok:true});
assert.equal(result.headers['Cache-Control'],'no-store');
assert.equal((await call()).status,429,'rapid duplicate tab heartbeat is bounded');
assert.equal(await n(),1);
await query("update live_visitor_sessions set last_seen_at=now()-interval '30 seconds'");
assert.equal((await call()).status,202);assert.equal(await n(),1,'same session never counts as another tab');
assert.equal((await call({value:{...payload,session_id:randomUUID()}})).status,202);
result=await counts();assert.equal(result.data.sites.find(s=>s.site===payload.site).active,2);
assert(result.data.estimated);assert.equal(result.data.synthetic,false);assert.equal(result.data.organization_id,String(org));
assert(!JSON.stringify(result.data).includes(id),'counts never reveal ephemeral identifiers');
assert.equal((await counts({...owner,organization_id:other})).data.sites.length,0);

// The two canonical agency hostnames are allowed; they do not authorize the landing site.
for(const origin of ['https://scaleparaguay.com','https://www.scaleparaguay.com']){
 assert.equal((await call({value:{site:'scale-website',session_id:id},extraHeaders:{origin}})).status,origin.includes('www.')?429:202);
}
assert.equal((await call({value:{site:'scale-website',session_id:randomUUID()},extraHeaders:{origin:'https://scaleparaguay.com',host:'sistema.scaleparaguay.com'}})).status,403);
assert.equal((await counts()).data.sites.find(s=>s.site==='scale-website').active,1);
const beforeDemo=await n();
const example=await counts({...owner,organization_id:demo,organization_slug:'visitor-demo',demo_owner_user_id:uid});
assert.equal(example.data.synthetic,true);assert.deepEqual(example.data.sites,[{site:'demo-website',label:'Web de ejemplo',active:3}]);
assert.equal(await n(),beforeDemo,'demo does not create real telemetry');
await query("insert into live_visitor_sites(site_key,organization_id,label,origins,request_hosts) values('demo-test',$1,'Demo',array['https://sistema.scaleparaguay.com'],array['admin.scaleparaguay.com'])",[demo]);
assert.equal((await call({value:{...payload,site:'demo-test'}})).status,403,'public tracker cannot bind to a demo org');

await query("update live_visitor_sessions set expires_at=now()-interval '1 second' where site_key=$1",[payload.site]);
assert.equal((await counts()).data.sites.find(s=>s.site===payload.site).active,0,'expiry excludes stale visitors before cleanup');
await purgeLiveVisitors(db);assert.equal(await n(),1,'expired rows physically deleted; active site kept');
await query("update live_visitor_sessions set first_seen_at=now()-interval '14 minutes 40 seconds',last_seen_at=now()-interval '30 seconds'");
assert.equal((await call({value:{site:'scale-website',session_id:id},extraHeaders:{origin:'https://scaleparaguay.com'}})).status,202);
const lifetime=Number((await query('select extract(epoch from expires_at-first_seen_at) as seconds from live_visitor_sessions')).rows[0].seconds);
assert.equal(lifetime,900,'server bounds continuous identifier life to 15 minutes');

await query("update live_visitor_sites set rate_count=599,rate_started_at=now() where site_key=$1",[payload.site]);
assert.equal((await call()).status,202);
assert.equal((await call({value:{...payload,session_id:randomUUID()}})).status,429,'site rate cap also limits newly generated IDs');
assert.equal((await query('select rate_count from live_visitor_sites where site_key=$1',[payload.site])).rows[0].rate_count,600);
await query("update live_visitor_sites set rate_started_at=now()-interval '61 seconds' where site_key=$1",[payload.site]);
assert.equal((await call({value:{...payload,session_id:randomUUID()}})).status,202);
await query('update live_visitor_sites set enabled=false where site_key=$1',[payload.site]);
assert.equal((await call()).status,403);assert.equal((await counts()).data.sites.length,1);
await query('update organizations set active=false where id=$1',[org]);
assert.equal((await call({value:{site:'scale-website',session_id:randomUUID()},extraHeaders:{origin:'https://scaleparaguay.com'}})).status,403);
assert.equal((await counts()).data.sites.length,0);

// Cleanup runs independently of traffic and has a stoppable lifecycle.
let cleanupCalls=0;const stop=startLiveVisitorCleanup({query:async sql=>{assert(sql.includes('expires_at<=now()'));cleanupCalls++;}});
await new Promise(resolve=>setImmediate(resolve));stop();assert.equal(cleanupCalls,1);
await pg.close();
console.log('PASS: live visitors auth/roles, tenant isolation, exact origin/host/site bindings, payload cap, tab dedup, demo isolation, 90s expiry, 15min lifetime, per-session/site rate limits and physical cleanup');
