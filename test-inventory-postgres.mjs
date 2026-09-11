import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {accessSync,chmodSync,constants,existsSync,lstatSync,mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {inventoryReservations} from './inventory-reservations.js';

// pg falls back to PG* even for some explicitly empty options. Strip names only,
// without reading or printing their values; this affects this standalone process.
for(const name of Object.keys(process.env))if(name.startsWith('PG')||name==='DATABASE_URL')delete process.env[name];
const repo=path.dirname(fileURLToPath(import.meta.url));
const bin=path.resolve(process.env.SCALE_TEST_PG_BIN||'/opt/homebrew/opt/postgresql@16/bin');
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',maxBuffer:16*1024*1024});
const revision=git('rev-parse','HEAD').trim();
const committed=file=>git('show',`${revision}:${file}`);
const schema=committed('schema.sql'),server=committed('server.js');
const start=server.indexOf('async function init()'),end=server.indexOf("await migration.query('commit')",start);
assert(start>=0&&end>start,'Cannot identify HEAD migration transaction');
const migrations=[...server.slice(start,end).matchAll(/(\d{8}_[a-z0-9_]+\.sql)/g)].map(match=>match[1]).filter(name=>!name.includes('dadoo'));
assert.equal(migrations.length,new Set(migrations).size,'Duplicate migration registration');
assert(migrations.includes('20260910_inventory_reservations.sql'));
assert(!/\bdadoo_/i.test(schema),'HEAD schema contains Dadoo; do not silently load another product');
// Freeze every SQL source to one HEAD, including if another task commits mid-run.
const sources=[['schema.sql',schema],...migrations.map(name=>[`migrations/${name}`,committed(`migrations/${name}`)])];

let temporary=null,pool=null,cleaned=false;
const port=55432,user='scale_inventory_fixture';
// Never inherit libpq/service/password/database configuration into subprocesses.
const localEnv={PATH:`${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,LANG:'C',LC_ALL:'C',TZ:'UTC'};
const pgTool=(name,args,timeout=30000)=>execFileSync(path.join(bin,name),args,{env:localEnv,encoding:'utf8',timeout,maxBuffer:4*1024*1024});
function cleanupCluster(){
 if(!temporary||cleaned)return;
 const data=path.join(temporary,'data');
 const stopped=()=>{try{pgTool('pg_ctl',['-D',data,'status'],5000);return false;}catch(error){if(error.status===3)return true;throw error;}};
 // Stop first. Never remove the directory if shutdown cannot be confirmed.
 if(existsSync(path.join(data,'PG_VERSION'))&&!stopped()){
  try{pgTool('pg_ctl',['-D',data,'stop','-m','fast','-w','-t','10'],15000);}
  catch{pgTool('pg_ctl',['-D',data,'stop','-m','immediate','-w','-t','10'],15000);}
  assert(stopped(),'Temporary PostgreSQL is still running; directory retained');
 }
 assert(/^\/(?:private\/)?tmp\/scale-inventory-pg-[A-Za-z0-9]+$/.test(temporary),'Unsafe cleanup target');
 assert(lstatSync(temporary).isDirectory()&&!lstatSync(temporary).isSymbolicLink());
 assert.equal(realpathSync(temporary),temporary);
 rmSync(temporary,{recursive:true,force:false});cleaned=true;
 console.log(`CLEANUP stopped and removed ${temporary}`);
}
// Finally handles ordinary errors; exit is a synchronous fallback for Ctrl-C/TERM.
const exitCleanup=()=>{try{cleanupCluster();}catch(error){console.error(`CLEANUP FAILED; retained ${temporary}: ${error.message}`);process.exitCode=1;}};
process.on('exit',exitCleanup);
const interrupt=()=>process.exit(130),terminate=()=>process.exit(143);
process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);

function barrier(label){
 let arrivals=0,release,reject;
 const gate=new Promise((yes,no)=>{release=yes;reject=no;});
 const timeout=setTimeout(()=>reject(Error(`${label}: two connections did not reach the barrier`)),8000);
 // A rejected gate is consumed even if connection acquisition failed before arrival.
 gate.catch(()=>{});
 return {async wait(){arrivals++;assert(arrivals<=2);if(arrivals===2){clearTimeout(timeout);release();}await gate;},get arrivals(){return arrivals;},dispose(){clearTimeout(timeout);}};
}
async function waitForBlock(waiter,holder,label){
 const deadline=Date.now()+6000;
 while(Date.now()<deadline){
  const {rows}=await pool.query('select pg_blocking_pids($1::int) as blockers',[waiter]);
  if(rows[0].blockers.includes(holder)){console.log(`BLOCK ${label}: PID ${waiter} waits for PID ${holder}`);return;}
  await delay(10);
 }
 throw Error(`${label}: no PostgreSQL lock wait observed (${waiter} -> ${holder})`);
}
async function call(route,method,payload,actor,db=pool){
 let response;
 const handled=await inventoryReservations({req:{method,socket:{remoteAddress:'local-pg-fixture'}},res:{},url:new URL(`/api/agency/${route}`,'https://fixture.invalid'),db,session:async()=>actor,body:async()=>payload,send:(_,status,data)=>{response={status,...data};}});
 assert.equal(handled,true);assert(response,'Handler did not respond');return response;
}
async function race(label,operations,{blocking=true}={}){
 const gate=barrier(label),pids=[],arrived=new Set();let holder=null;
 const db={async connect(){
  const client=await pool.connect();
  try{
   const pid=(await client.query('select pg_backend_pid() as pid')).rows[0].pid;
   pids.push(pid);assert.equal(new Set(pids).size,pids.length,'Connections must have different backend PIDs');
   return {release:()=>client.release(),async query(sql,args){
    // This lock precedes all handler writes. A barrier after it would deadlock
    // the fixture itself, because production intentionally serializes each org.
    if(/^select id from organizations where id=\$1 and active for update$/i.test(sql.trim().replace(/\s+/g,' '))){
     assert(!arrived.has(pid));arrived.add(pid);
     await gate.wait();
     const result=await client.query(sql,args);
     if(blocking&&holder===null){holder=pid;await waitForBlock(pids.find(other=>other!==pid),pid,label);}
     return result;
    }
    return client.query(sql,args);
   }};
  }catch(error){client.release();throw error;}
 }};
 try{
  const settled=await Promise.allSettled(operations.map(operation=>operation(db)));
  assert.equal(gate.arrivals,2,`${label}: barrier not exercised`);assert.equal(pids.length,2);
  for(const result of settled)if(result.status==='rejected')throw result.reason;
  const results=settled.map(result=>result.value);
  console.log(`RACE ${label}: PIDs ${pids.join(', ')} -> ${results.map(result=>result.status).join(', ')}`);
  return results;
 }finally{gate.dispose();}
}
const expectStatuses=(results,statuses)=>assert.deepEqual(results.map(result=>result.status).sort(),statuses.sort(),JSON.stringify(results));
const ok=(response,status=200)=>{assert.equal(response.status,status,JSON.stringify(response));return response;};

async function runCases(){
 const insert=async(sql,args)=>(await pool.query(`${sql} returning id`,args)).rows[0].id;
 async function tenant(slug){
  const org=await insert('insert into organizations(slug,name) values($1,$1)',[slug]);
  const uid=await insert('insert into users(email,password_hash) values($1,$2)',[`${slug}@example.invalid`,'fixture-not-a-password']);
  await pool.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,uid]);
  const client=await insert('insert into agency_clients(organization_id,name) values($1,$2)',[org,`${slug} client`]);
  const project=await insert('insert into agency_projects(organization_id,client_id,name) values($1,$2,$3)',[org,client,`${slug} project`]);
  return {project,actor:{id:uid,organization_id:org,role:'owner'}};
 }
 const a=await tenant('pg-fixture-a'),b=await tenant('pg-fixture-b');
 const item=async(name,tenant=a)=>ok(await call('inventory','POST',{name,category:'Concurrency fixture',storage_shelf:'Initial'},tenant.actor),201).record.id;
 const camera=await item('Camera fixture'),audio=await item('Audio fixture'),adjacent=await item('Adjacent fixture'),foreign=await item('Tenant B fixture',b);
 const now=Date.now(),iso=offset=>new Date(now+offset).toISOString();
 const payload=(ids,tenant=a,extra={})=>({title:'Local PostgreSQL fixture',project_id:tenant.project,inventory_ids:ids,responsible_user_ids:[tenant.actor.id],return_user_id:tenant.actor.id,starts_at:iso(-300000),ends_at:iso(3600000),...extra});
 const shared=payload([camera,audio]);
 const overlap=await race('overlapping reservations',[db=>call('inventory-reservations','POST',shared,a.actor,db),db=>call('inventory-reservations','POST',shared,a.actor,db)]);
 expectStatuses(overlap,[201,409]);let booking=overlap.find(result=>result.status===201).reservation;
 assert.equal((await pool.query('select count(*)::int as n from agency_inventory_reservation_items where inventory_id=$1',[camera])).rows[0].n,1);

 const adjacentResults=await race('adjacent half-open slots',[
  db=>call('inventory-reservations','POST',payload([adjacent],a,{starts_at:iso(7200000),ends_at:iso(10800000)}),a.actor,db),
  db=>call('inventory-reservations','POST',payload([adjacent],a,{starts_at:iso(10800000),ends_at:iso(14400000)}),a.actor,db)
 ]);
 expectStatuses(adjacentResults,[201,201]);
 assert.equal((await pool.query('select count(*)::int as n from agency_inventory_reservation_items where inventory_id=$1',[adjacent])).rows[0].n,2);

 const originalVersion=booking.version;
 const edits=await race('optimistic edit', ['Edit A','Edit B'].map(title=>db=>call(`inventory-reservations/${booking.id}`,'PATCH',{...shared,title,expected_version:originalVersion},a.actor,db)));
 expectStatuses(edits,[200,409]);booking=edits.find(result=>result.status===200).reservation;
 assert.equal(booking.version,originalVersion+1);assert.equal(booking.items.length,2);
 assert.equal(ok(await call(`inventory-reservations/${booking.id}`,'GET',{},a.actor)).reservation.title,booking.title);

 const beforeCheckout=booking.version;
 const checkouts=await race('idempotent checkout',[0,1].map(()=>db=>call(`inventory-reservations/${booking.id}/checkout`,'POST',{expected_version:beforeCheckout,custodian_user_id:a.actor.id},a.actor,db)));
 expectStatuses(checkouts,[200,200]);assert.equal(checkouts.filter(result=>result.alreadyRecorded===true).length,1);
 booking=checkouts[0].reservation;assert.equal(booking.status,'checked_out');assert.equal(booking.version,beforeCheckout+1);assert(booking.checked_out_at);
 let stock=(await pool.query('select status,custodian_user_id from agency_inventory where id=any($1::bigint[]) order by id',[[camera,audio]])).rows;
 assert(stock.every(row=>row.status==='in_use'&&row.custodian_user_id===a.actor.id));
 assert((await pool.query('select status from agency_inventory_reservation_items where reservation_id=$1',[booking.id])).rows.every(row=>row.status==='checked_out'));

 const beforeReturn=booking.version,locations=[{inventory_id:camera,storage_shelf:'Shelf A',storage_row:'Row 1',status:'available'},{inventory_id:audio,storage_shelf:'Service bench',storage_row:'Row 2',status:'maintenance'}];
 const returns=await race('idempotent return',[0,1].map(()=>db=>call(`inventory-reservations/${booking.id}/return`,'POST',{expected_version:beforeReturn,locations},a.actor,db)));
 expectStatuses(returns,[200,200]);assert.equal(returns.filter(result=>result.alreadyRecorded===true).length,1);
 booking=returns[0].reservation;assert.equal(booking.status,'returned');assert.equal(booking.version,beforeReturn+1);assert(booking.returned_at);
 const repeated=ok(await call(`inventory-reservations/${booking.id}/return`,'POST',{},a.actor));
 assert.equal(repeated.alreadyRecorded,true);assert.deepEqual(repeated.reservation,booking,'Repeated return must preserve timestamps, versions and assignments');
 stock=(await pool.query('select id,status,custodian_user_id,storage_shelf,storage_row from agency_inventory where id=any($1::bigint[]) order by id',[[camera,audio]])).rows;
 for(const location of locations){const row=stock.find(row=>row.id===location.inventory_id);assert.equal(row.status,location.status);assert.equal(row.custodian_user_id,null);assert.equal(row.storage_shelf,location.storage_shelf);assert.equal(row.storage_row,location.storage_row);}
 assert((await pool.query('select status from agency_inventory_reservation_items where reservation_id=$1',[booking.id])).rows.every(row=>row.status==='returned'));

 const parallelTenants=await race('independent tenants',[
  db=>call('inventory-reservations','POST',payload([camera]),a.actor,db),
  db=>call('inventory-reservations','POST',payload([foreign],b),b.actor,db)
 ],{blocking:false});expectStatuses(parallelTenants,[201,201]);
 const snapshot=await call('inventory','GET',{},b.actor);
 assert.equal((await call(`inventory-reservations/${booking.id}`,'GET',{},b.actor)).status,404);
 assert.equal((await call(`inventory-reservations/${booking.id}/return`,'POST',{},b.actor)).status,404);
 assert.equal((await call('inventory-reservations','POST',payload([foreign]),a.actor)).status,400);
 assert.equal((await call('inventory-reservations','POST',payload([camera],a,{project_id:b.project}),a.actor)).status,400);
 assert.equal((await call('inventory-reservations','POST',payload([camera],a,{responsible_user_ids:[b.actor.id],return_user_id:b.actor.id}),a.actor)).status,400);
 assert.equal((await call('inventory','GET',{}, {...a.actor,organization_id:b.actor.organization_id})).status,403);
 assert.deepEqual(await call('inventory','GET',{},b.actor),snapshot,'Foreign attempts must not alter tenant B');
 const records=ok(await call('inventory-reservations','GET',{},b.actor)).reservations;
 assert.equal(records.length,1);assert(records.every(row=>row.organization_id===b.actor.organization_id));
 console.log('PASS tenant reads/writes/membership isolation; custody, return locations and exact version increments');

 // Defense in depth: bypass handler/org lock and contend directly on GiST.
 const directItem=await item('Direct GiST fixture');
 const parent=()=>insert('insert into agency_inventory_reservations(organization_id,project_id,title,starts_at,ends_at,created_by_user_id,return_user_id) values($1,$2,$3,$4,$5,$6,$6)',[a.actor.organization_id,a.project,'Direct SQL fixture',iso(0),iso(3600000),a.actor.id]);
 const parents=[await parent(),await parent()],clients=await Promise.all([pool.connect(),pool.connect()]);
 const gate=barrier('direct GiST');let firstInserted,firstFailed;
 const inserted=new Promise((resolve,reject)=>{firstInserted=resolve;firstFailed=reject;});inserted.catch(()=>{});
 try{
  const pids=await Promise.all(clients.map(async client=>(await client.query('select pg_backend_pid() as pid')).rows[0].pid));
  assert.notEqual(pids[0],pids[1]);
  const attempts=await Promise.all(clients.map(async(client,index)=>{
   await client.query('begin');
   try{
    await gate.wait();
    // Both transactions reached the barrier. Stage the first uncommitted tuple
    // before issuing the second insert, avoiding a mutual GiST insertion deadlock.
    if(index===1)await inserted;
    await client.query('insert into agency_inventory_reservation_items(organization_id,reservation_id,inventory_id) values($1,$2,$3)',[a.actor.organization_id,parents[index],directItem]);
    if(index===0)firstInserted();
    await waitForBlock(pids[1-index],pids[index],'direct GiST');
    await client.query('commit');return {code:'committed'};
   }catch(error){if(index===0)firstFailed(error);await client.query('rollback');return {code:error.code||error.message,constraint:error.constraint};}
  }));
  assert.deepEqual(attempts.map(result=>result.code).sort(),['23P01','committed']);
  assert.equal(attempts.find(result=>result.code==='23P01').constraint,'inventory_no_overlapping_reservations');
  assert.equal((await pool.query('select count(*)::int as n from agency_inventory_reservation_items where inventory_id=$1',[directItem])).rows[0].n,1);
  console.log(`PASS direct inventory_no_overlapping_reservations: PIDs ${pids.join(', ')} -> ${attempts.map(result=>result.code).join(', ')}`);
 }finally{gate.dispose();clients.forEach(client=>client.release());}
}

async function main(){
 assert.notEqual(process.getuid?.(),0,'initdb must run as an unprivileged OS user');
 for(const tool of ['initdb','pg_ctl','postgres'])accessSync(path.join(bin,tool),constants.X_OK);
 temporary=realpathSync(mkdtempSync('/tmp/scale-inventory-pg-'));chmodSync(temporary,0o700);
 const data=path.join(temporary,'data'),socket=path.join(temporary,'socket');
 mkdirSync(socket,{mode:0o700});assert.equal(lstatSync(socket).mode&0o777,0o700);
 console.log(`TEMP ${temporary}; SQL HEAD ${revision}; ${migrations.length} migrations; Dadoo excluded`);
 try{
  pgTool('initdb',['-D',data,`--username=${user}`,'--auth-local=trust','--auth-host=reject','--encoding=UTF8','--locale=C']);
  const options=`-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c port=${port} -c max_connections=12 -c timezone=UTC -c statement_timeout=15000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=20000`;
  pgTool('pg_ctl',['-D',data,'-l',path.join(temporary,'postgres.log'),'-o',options,'-w','-t','15','start']);
  // All routing/auth/SSL options are explicit; no DATABASE_URL or PG* values.
  pool=new pg.Pool({host:socket,port,user,database:'postgres',password:'fixture-local-only',ssl:false,options:'-c search_path=public',application_name:'scale-inventory-concurrency-fixture',max:6,connectionTimeoutMillis:5000,idleTimeoutMillis:1000});
  pool.on('error',error=>{console.error(`Temporary pool: ${error.message}`);process.exitCode=1;});
  const info=(await pool.query("select version(),current_setting('data_directory') as data,current_setting('listen_addresses') as listen,inet_server_addr() as address")).rows[0];
  assert.equal(realpathSync(info.data),realpathSync(data));assert.equal(info.listen,'');assert.equal(info.address,null);
  console.log(`SERVER ${info.version}; Unix socket only; pool max=${pool.options.max}`);
  const migration=await pool.connect();
  try{
   await migration.query('begin');
   for(const [file,sql] of sources){try{await migration.query(sql);}catch(error){throw Error(`HEAD migration ${file}: ${error.message}`,{cause:error});}}
   await migration.query('commit');
  }catch(error){await migration.query('rollback');throw error;}finally{migration.release();}
  await runCases();
  console.log('PASS real PostgreSQL: six handler races plus direct constraint race; no PGlite, HTTP, UI or production connection');
 }finally{
  // Bound pool draining too: leaked/failed leases must not prevent pg_ctl stop.
  let timer;
  try{if(pool)await Promise.race([pool.end(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Pool did not drain before shutdown')),5000);})]);}
  finally{clearTimeout(timer);cleanupCluster();}
 }
}
try{await main();}catch(error){console.error(error.stack||error);process.exitCode=1;}
finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);}
