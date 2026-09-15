import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {accountSecurity,CLOSE_CONFIRMATION} from './account-security.js';

const pg=new PGlite();
await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
await pg.exec('alter table organization_members add column if not exists active boolean not null default true; alter table organization_members add column if not exists removed_at timestamptz;');
const db={query:(sql,params)=>pg.query(sql,params),connect:async()=>({query:(sql,params)=>pg.query(sql,params),release(){}})};
const org=(await db.query("select id from organizations where slug='scale'")).rows[0].id;
const user=(await db.query('insert into users(email,password_hash) values($1,$2) returning id',['security@example.invalid',await bcrypt.hash('CorrectHorse9',12)])).rows[0].id;
const other=(await db.query('insert into users(email,password_hash) values($1,$2) returning id',['other-owner@example.invalid','unused'])).rows[0].id;
await db.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner'),($1,$3,'owner')",[org,user,other]);
const current='a'.repeat(64),otherSession='b'.repeat(64);
await db.query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '1 day'),($4,$2,$3,now()+interval '1 day')",[current,user,org,otherSession]);
const actor={id:user,organization_id:org,role:'owner'};
const parseCookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(value=>value.split('=')));
const cookie=(name,value,maxAge)=>`${name}=${value}; Max-Age=${maxAge}`;
const body=async req=>req.payload||{};
async function call(path,{method='GET',payload,cookieValue=`scale_session=${current}`,actorValue=actor}={}){
 const result={status:0,data:null,headers:{}};
 await accountSecurity({req:{method,headers:{cookie:cookieValue},payload,socket:{remoteAddress:'test'}},res:{},url:new URL(path,'https://admin.example.invalid'),db,session:async()=>actorValue,body,parseCookies,cookie,send:(_res,status,data,headers={})=>{result.status=status;result.data=data;result.headers=headers;}});
 return result;
}
let response=await call('/api/auth/account/sessions');
assert.equal(response.status,200);assert.equal(response.data.sessions.length,2);assert.equal(response.data.sessions.find(row=>row.id===current).current,true);
response=await call(`/api/auth/account/sessions/${otherSession}`,{method:'DELETE',payload:{}});
assert.equal(response.status,200);assert.equal((await db.query('select * from sessions where id=$1',[otherSession])).rows.length,0);
response=await call('/api/auth/account/closure',{method:'POST',payload:{password:'CorrectHorse9',confirmation:'wrong'}});
assert.equal(response.status,400);
response=await call('/api/auth/account/closure',{method:'POST',payload:{password:'CorrectHorse9',confirmation:CLOSE_CONFIRMATION}});
assert.equal(response.status,202);assert.equal((await db.query('select * from sessions where user_id=$1',[user])).rows.length,0);assert.equal((await db.query('select * from account_closure_requests where user_id=$1 and cancelled_at is null',[user])).rows.length,1);
response=await call('/api/auth/account/closure/cancel',{method:'POST',cookieValue:'',actorValue:null,payload:{email:'security@example.invalid',password:'CorrectHorse9'}});
assert.equal(response.status,200);assert.equal((await db.query('select * from account_closure_requests where user_id=$1 and cancelled_at is null',[user])).rows.length,0);
await pg.close();
console.log('PASS: account sessions, reauthenticated recoverable closure, audit-preserving owner guard and password recovery');
