// Run with node --experimental-vm-modules test-auth.mjs.
// Uses a temporary embedded PostgreSQL database; never contacts Google or production.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
await db.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
for(const f of ['20260908_google_oauth.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql'])await db.exec(await fs.readFile(new URL(`./migrations/${f}`,import.meta.url),'utf8'));
const query=(s,v)=>db.query(s,v);
const org=(await query("insert into organizations(slug,name) values('other','Another agency') returning id")).rows[0].id;
const scale=(await query("select id from organizations where slug='scale'")).rows[0].id;
const uid=(await query("insert into users(email,password_hash) values('member@example.invalid','unused') returning id")).rows[0].id;
await query("insert into organization_members values($1,$2,'editor',now())",[org,uid]);
let handler,profile={email:'member@example.invalid',email_verified:true};
const context=vm.createContext({console,URL,URLSearchParams,Buffer,fetch:async url=>({ok:true,json:async()=>url.includes('/token')?{access_token:'mock'}:profile}),process:{env:{GOOGLE_CLIENT_ID:'mock',GOOGLE_CLIENT_SECRET:'mock'}},setTimeout,clearTimeout});
const module=new vm.SourceTextModule(await fs.readFile(new URL('./server.js',import.meta.url),'utf8'),{context,identifier:new URL('./server.js',import.meta.url).href,initializeImportMeta(meta){meta.url=new URL('./server.js',import.meta.url).href;}});
await module.link(async spec=>{
 let exports;
 if(spec==='node:http')exports={default:{createServer:fn=>{handler=fn;return{listen(){}};}}};
 else if(spec==='pg')exports={default:{Pool:class{query=query;}}};
 else if(spec==='./operations.js')exports={operations:async()=>false};
 else exports=await import(spec);
 const keys=Object.keys(exports);return new vm.SyntheticModule(keys,function(){keys.forEach(k=>this.setExport(k,exports[k]));},{context});
});
await module.evaluate();
async function request(path,{method='GET',cookie='',payload}={}){
 const result={status:0,headers:{},body:''};const req={url:path,method,headers:{host:'admin.scaleparaguay.com',cookie},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){if(payload)yield JSON.stringify(payload);}};
 await handler(req,{setHeader(k,v){result.headers[k]=v;},writeHead(s,h){result.status=s;Object.assign(result.headers,h);},end(b){result.body=b||'';}});return result;
}
async function callback(){const start=await request('/api/auth/google/start');assert.equal(start.status,302);const state=new URL(start.headers.Location).searchParams.get('state');const cookie=start.headers['Set-Cookie'].split(';')[0];return request(`/api/auth/google/callback?state=${state}&code=mock`,{cookie});}
let r=await request('/api/auth/google/callback?state=forged&code=mock');assert.equal(r.status,302);assert.ok(r.headers.Location.includes('authError'));
r=await callback();assert.equal(r.status,302);assert.ok(r.headers.Location.startsWith('https://app.scaleparaguay.com/core-api/api/auth/google/complete?ticket='));
const complete=new URL(r.headers.Location);r=await request(complete.pathname.replace('/core-api','')+complete.search);assert.equal(r.status,302);const cookie=r.headers['Set-Cookie'].split(';')[0];
assert.equal((await request(complete.pathname.replace('/core-api','')+complete.search)).headers['Set-Cookie'],undefined);
r=await request('/api/auth/me',{cookie});assert.equal(r.status,200);assert.equal(JSON.parse(r.body).user.organization_slug,'other');
r=await request('/api/auth/organizations',{cookie});assert.equal(JSON.parse(r.body).organizations.length,1);
r=await request('/api/auth/switch-organization',{cookie,method:'POST',payload:{organizationId:scale}});assert.equal(r.status,403);
await query("insert into organization_members values($1,$2,'viewer',now())",[scale,uid]);
r=await request('/api/auth/organizations',{cookie});assert.equal(JSON.parse(r.body).organizations.length,2);
r=await request('/api/auth/switch-organization',{cookie,method:'POST',payload:{organizationId:scale}});assert.equal(r.status,200);const switched=r.headers['Set-Cookie'].split(';')[0];
r=await request('/api/auth/me',{cookie:switched});assert.equal(JSON.parse(r.body).user.role,'viewer');assert.equal(JSON.parse(r.body).user.organization_slug,'scale');
profile={email:'uninvited@example.invalid',email_verified:true};r=await callback();assert.ok(r.headers.Location.includes('authError'));assert.equal(r.headers['Set-Cookie'],undefined);
await db.close();console.log('PASS: Google browser-state binding, membership in non-Scale agency, app session handoff, single-use ticket, denied nonmembers, agency choice, tenant-specific roles');
