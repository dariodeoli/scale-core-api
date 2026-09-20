import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {financeControls} from './finance-controls.js';

// pg falls back to PG* even for some explicitly empty options. Strip names only,
// without reading or printing their values; this affects this standalone process.
for(const name of Object.keys(process.env))if(name.startsWith('PG')||name==='DATABASE_URL')delete process.env[name];
const repo=path.dirname(fileURLToPath(import.meta.url));
const bin=path.resolve(process.env.SCALE_TEST_PG_BIN||'/opt/homebrew/opt/postgresql@16/bin');
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',maxBuffer:16*1024*1024});
const revision=git('rev-parse','HEAD').trim();
const committed=file=>git('show',`${revision}:${file}`);
const server=committed('server.js');
const start=server.indexOf('async function init()'),end=server.indexOf("await migration.query('commit')",start);
assert(start>=0&&end>start,'Cannot identify HEAD migration transaction');
const migrations=[...server.slice(start,end).matchAll(/(\d{8}_[a-z0-9_]+\.sql)/g)].map(match=>match[1]).filter(name=>!name.includes('dadoo'));
assert.equal(migrations.length,new Set(migrations).size,'Duplicate migration registration');
// Freeze the baseline to committed migrations only: in-flight migrations from
// other tasks are not required to exercise treasury concurrency.
const sources=[['schema.sql',committed('schema.sql')]];
for(const name of migrations){
 try{execFileSync('git',['cat-file','-e',`HEAD:migrations/${name}`],{cwd:repo,stdio:'ignore'});sources.push([`migrations/${name}`,committed(`migrations/${name}`)]);}
 catch{/* Uncommitted migration from another task; skip for this focused test. */}
}

let temporary=null,cleaned=false;
const port=55433,user='scale_treasury_fixture';
const localEnv={PATH:`${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,LANG:'C',LC_ALL:'C',TZ:'UTC'};
const pgTool=(name,args,timeout=30000)=>execFileSync(path.join(bin,name),args,{env:localEnv,encoding:'utf8',timeout,maxBuffer:4*1024*1024});
function cleanupCluster(){
 if(!temporary||cleaned)return;
 const data=path.join(temporary,'data');
 const stopped=()=>{try{pgTool('pg_ctl',['-D',data,'status'],5000);return false;}catch(error){if(error.status===3)return true;throw error;}};
 if(existsSync(path.join(data,'PG_VERSION'))&&!stopped()){
  try{pgTool('pg_ctl',['-D',data,'stop','-m','fast','-w','-t','10'],15000);}
  catch{pgTool('pg_ctl',['-D',data,'stop','-m','immediate','-w','-t','10'],15000);}
  assert(stopped(),'Temporary PostgreSQL is still running; directory retained');
 }
 assert(realpathSync(temporary).startsWith(path.join(realpathSync(process.env.TMPDIR||'/tmp'),'scale-treasury-pg-')),'Unsafe cleanup target');
 assert(lstatSync(temporary).isDirectory()&&!lstatSync(temporary).isSymbolicLink());
 assert(realpathSync(temporary).endsWith(path.basename(temporary)),'Unexpected symlink target');
 rmSync(temporary,{recursive:true,force:false});cleaned=true;
 console.log(`CLEANUP stopped and removed ${temporary}`);
}
const exitCleanup=()=>{try{cleanupCluster();}catch(error){console.error(`CLEANUP FAILED; retained ${temporary}: ${error.message}`);process.exitCode=1;}};
process.on('exit',exitCleanup);
const interrupt=()=>process.exit(130),terminate=()=>process.exit(143);
process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);

try{
 temporary=mkdtempSync(path.join(process.env.TMPDIR||'/tmp','scale-treasury-pg-'));
 const data=path.join(temporary,'data');
 pgTool('initdb',['-D',data,'-U',user,'--no-locale','-E','UTF8']);
 pgTool('pg_ctl',['-D',data,'-l',path.join(temporary,'postgres.log'),'-o',`-p ${port} -h 127.0.0.1 -F -c max_connections=40 -c listen_addresses=127.0.0.1`,'-w','-t','60','start'],60000);
 const pool=new pg.Pool({host:'127.0.0.1',port,user,database:'postgres'});
 pool.on('error',()=>{});
 const query=(sql,args)=>pool.query(sql,args);
 const db={query,connect:async()=>{const client=await pool.connect();return{query:(sql,args)=>client.query(sql,args),release:()=>client.release()};}};
 for(const [name,content] of sources){await pool.query(content);}
 const org=(await query("insert into organizations(slug,name) values('treasury','Treasury fixture') returning id")).rows[0].id;
 const uid=(await query("insert into users(email,password_hash) values('treasury@example.invalid','unused') returning id")).rows[0].id;
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,uid]);
 const token='treasury-session-fixture';
 await query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '1 hour')",[token,uid,org]);
 const client=(await query("insert into agency_clients(organization_id,name) values($1,'Concurrent client') returning id",[org])).rows[0].id;
 const invoice=(await query("insert into agency_invoices(organization_id,client_id,number,currency,total) values($1,$2,'F-CONC','PYG',100) returning id",[org,client])).rows[0].id;
 const accountA=(await query("insert into bank_accounts(organization_id,name,account_type,currency,balance) values($1,'Caja A','bank','PYG',50) returning id",[org])).rows[0].id;
 const accountB=(await query("insert into bank_accounts(organization_id,name,account_type,currency,balance) values($1,'Caja B','bank','PYG',0) returning id",[org])).rows[0].id;
 const accountC=(await query("insert into bank_accounts(organization_id,name,account_type,currency,balance) values($1,'Caja C','bank','PYG',50) returning id",[org])).rows[0].id;
 const actor={id:uid,email:'treasury@example.invalid',organization_id:org,role:'owner',organization_name:'Treasury fixture'};
 const session=async()=>actor;
 async function call(method,pathname,payload){
  let response;
  const req={method,socket:{remoteAddress:'127.0.0.1'},headers:{cookie:`scale_session=${token}`}};
  // Issue #13: cobros y transferencias los sirve finance-controls, que corre antes
  // que agency-core en server.js; las copias legacy se retiraron.
  const handled=await financeControls({req,res:{},url:new URL(`https://test${pathname}`),db,session,body:async()=>payload,send:(_,status,data)=>{response={status,...data};}});
  if(handled!==true)console.log('NOT HANDLED',pathname,response);assert.equal(handled,true,pathname);
  return response;
 }
 // Two concurrent payments of 60 against a 100 invoice: exactly one can win.
 const payments=await Promise.all([call('POST','/api/agency/payments',{invoiceId:invoice,accountId:accountA,amount:60}),call('POST','/api/agency/payments',{invoiceId:invoice,accountId:accountA,amount:60})]);
 const paymentStatuses=payments.map(p=>p.status).sort();
 
 assert.deepEqual(paymentStatuses,[201,400],`one payment wins, the other is rejected: ${JSON.stringify(payments)}`);
 const paid=(await query('select paid_amount from agency_invoices where id=$1',[invoice])).rows[0].paid_amount;
 assert.equal(Number(paid),60,'the invoice never overpays under concurrency');
 // Two concurrent transfers of 40 from an account with 50: no negative balance.
 const transfers=await Promise.all([call('POST','/api/agency/transfers',{fromAccountId:accountC,toAccountId:accountB,amount:40}),call('POST','/api/agency/transfers',{fromAccountId:accountC,toAccountId:accountB,amount:40})]);
 const transferStatuses=transfers.map(t=>t.status).sort();
 
 assert.deepEqual(transferStatuses,[201,409],`one transfer wins, the other is rejected with insufficient funds: ${JSON.stringify(transfers)}`);
 const balances=(await query('select id,balance from bank_accounts where organization_id=$1 order by id',[org])).rows;
 assert.equal(Number(balances.find(row=>Number(row.id)===Number(accountC)).balance),10,'source account never goes negative under concurrency');
 assert.equal(Number(balances.find(row=>Number(row.id)===Number(accountB)).balance),40,'destination receives exactly one transfer');
 console.log('PASS: concurrent payments cannot overpay an invoice and concurrent transfers cannot overdraw an account');
}catch(error){console.error(error);process.exitCode=1;}
finally{try{await pool.end();}catch{/* pool may already be closed */}cleanupCluster();}
