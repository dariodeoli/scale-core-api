// Manual infrastructure check. Never restores over the live database.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
const exec=promisify(execFile);
const sourceUrl=new URL(process.env.DATABASE_URL);
const name='scale_restore_'+crypto.randomBytes(12).toString('hex');
if(!/^scale_restore_[a-f0-9]{24}$/.test(name)||decodeURIComponent(sourceUrl.pathname.slice(1))===name)throw new Error('Unsafe restoration target');
const source=new pg.Client({connectionString:sourceUrl.href});
const restoredUrl=new URL(sourceUrl);restoredUrl.pathname='/'+name;
const restored=new pg.Client({connectionString:restoredUrl.href});
let created=false,connected=false,dir;
const env={...process.env,PGHOST:sourceUrl.hostname,PGPORT:sourceUrl.port||'5432',PGUSER:decodeURIComponent(sourceUrl.username),PGPASSWORD:decodeURIComponent(sourceUrl.password),PGDATABASE:decodeURIComponent(sourceUrl.pathname.slice(1)),PGSSLMODE:sourceUrl.searchParams.get('sslmode')||'prefer'};
const fingerprint=async(client,table)=>{if(!/^[a-z_][a-z0-9_]*$/.test(table))throw new Error('Unexpected table name');return(await client.query(`select count(*)::int as count,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as digest from "${table}" t`)).rows[0];};
try{
 await source.connect();await source.query(`create database "${name}"`);created=true;
 dir=await fs.mkdtemp(path.join(os.tmpdir(),'scale-restore-check-'));
 await source.query('begin isolation level repeatable read read only');
 const snapshot=(await source.query('select pg_export_snapshot() as id')).rows[0].id;
 const tables=(await source.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(r=>r.tablename);
 const expected=new Map();for(const table of tables)expected.set(table,await fingerprint(source,table));
 await exec('pg_dump',['--format=custom','--no-owner','--no-acl','--schema=public','--snapshot='+snapshot,'--file='+path.join(dir,'verification.dump')],{env,timeout:180000,maxBuffer:1024*1024});
 await source.query('commit');
 await exec('pg_restore',['--exit-on-error','--no-owner','--no-acl','--dbname='+name,path.join(dir,'verification.dump')],{env,timeout:180000,maxBuffer:1024*1024});
 await restored.connect();connected=true;let records=0;
 for(const table of tables){const result=await fingerprint(restored,table),want=expected.get(table);if(result.count!==want.count||result.digest!==want.digest)throw new Error('Restored data mismatch: '+table);records+=result.count;}
 const constraints=(await restored.query("select count(*)::int as count from pg_constraint where connamespace='public'::regnamespace and not convalidated")).rows[0].count;
 if(constraints)throw new Error('Unvalidated constraints in restored database');
 console.log(JSON.stringify({event:'restore_verification_passed',tables:tables.length,records,sourceUnchanged:true}));
}catch(error){console.error(JSON.stringify({event:'restore_verification_failed',code:error.code||'CHECK_FAILED',message: error.message?.startsWith('Restored data mismatch')?error.message:'Check failed; inspect infrastructure configuration without exposing credentials'}));process.exitCode=1;}
finally{
 if(connected)await restored.end();
 await source.query('rollback').catch(()=>{});
 if(created){await source.query(`drop database "${name}"`);console.log(JSON.stringify({event:'restore_scratch_database_removed'}));}
 await source.end().catch(()=>{});
 if(dir){await fs.unlink(path.join(dir,'verification.dump')).catch(e=>{if(e.code!=='ENOENT')throw e;});await fs.rmdir(dir);}
}
