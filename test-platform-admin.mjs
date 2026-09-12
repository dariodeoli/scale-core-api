import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {platformAdmin,platformBootstrapEmails} from './platform-admin.js';
const pg=new PGlite();
await pg.exec(`
 create table users(id bigint primary key,email text not null,created_at timestamptz not null default now(),is_demo_guest boolean not null default false);
 create table organizations(id bigint primary key,name text not null,slug text not null,active boolean not null default true,created_at timestamptz not null default now(),demo_owner_user_id bigint,demo_source_id bigint);
 create table organization_members(organization_id bigint,user_id bigint,active boolean not null default true,removed_at timestamptz,role text);
 create table organization_subscriptions(organization_id bigint primary key,status text,currency text,amount numeric,trial_ends_at timestamptz,due_at timestamptz);
 insert into users(id,email) values(1,'owner@agency.example'),(2,'platform@scale.example'),(3,'member@agency.example');
 insert into organizations(id,name,slug) values(10,'Agency One','agency-one'),(20,'Agency Two','agency-two'),(30,'Demo','scale-demo-controles-20260908');
 insert into organization_members values(10,1,true,null,'owner'),(10,3,true,null,'viewer'),(20,2,true,null,'owner');
 insert into organization_subscriptions values(10,'trialing','USD',10,null,null),(20,'active','PYG',50000,null,null);
`);
await pg.exec(await (await import('node:fs/promises')).readFile(new URL('./migrations/20260912_platform_admin.sql',import.meta.url),'utf8'));
await pg.query('insert into platform_administrators(user_id) values(2)');
const db={query:(sql,values)=>pg.query(sql,values)};
async function call(path,{method='GET',actor={id:2,email:'platform@scale.example'},payload={}}={}){
 let answer;const handled=await platformAdmin({req:{method},res:{},url:new URL(path,'https://isolated.invalid'),db,session:async()=>actor,body:async()=>payload,send:(_res,status,data)=>{answer={status,data};}});
 return {handled,...answer};
}
assert.deepEqual(platformBootstrapEmails(' A@Scale.Example, a@scale.example, invalid '),['a@scale.example']);
assert.equal((await call('/api/agency/clients')).handled,false);
assert.equal((await call('/api/platform/overview',{actor:{id:1,email:'owner@agency.example'}})).status,403,'agency owner must not inherit platform access');
assert.equal((await call('/api/platform/overview',{actor:{id:2,email:'platform@scale.example',demo_owner_user_id:2}})).status,403,'a Demo context cannot access platform administration');
const overview=await call('/api/platform/overview');assert.equal(overview.status,200);assert.equal(overview.data.agencies.total,2,'demo is excluded');assert.equal(overview.data.users.total,3);
const agencies=await call('/api/platform/agencies?limit=1');assert.equal(agencies.status,200);assert.equal(agencies.data.agencies.length,1);assert(!Object.keys(agencies.data.agencies[0]).some(k=>k.includes('stripe')||k.includes('password')));
const users=await call('/api/platform/users?q=member');assert.equal(users.status,200);assert.equal(users.data.users[0].email,'member@agency.example');
let coupon=await call('/api/platform/coupons',{method:'POST',payload:{code:'SCALE10',discount_type:'percent',discount_value:10,currency:null,max_redemptions:25}});assert.equal(coupon.status,201);assert.equal(coupon.data.coupon.code,'SCALE10');
coupon=await call('/api/platform/coupons/'+coupon.data.coupon.id,{method:'PATCH',payload:{active:false}});assert.equal(coupon.status,200);assert.equal(coupon.data.coupon.active,false);
assert.equal((await call('/api/platform/coupons',{method:'POST',payload:{code:'bad code',discount_type:'percent',discount_value:10}})).status,400);
assert.equal((await pg.query('select count(*)::int as n from platform_audit_log')).rows[0].n,2);
await pg.close();
console.log('PASS: separated platform admin authorization, scoped lists, safe coupon catalog and audit; agency ownership grants no global access.');
