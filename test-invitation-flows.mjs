// Isolated invitation regressions. Uses embedded PostgreSQL and no external services.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {claimInvite,inviteLinks,resolveInvite} from './invite-links.js';

const migrations=[
 '20260908_treasury_ledger.sql','20260908_google_oauth.sql','20260908_people_commissions_comments.sql',
 '20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql',
 '20260908_agency_suite.sql','20260908_daily_controls.sql','20260910_productivity.sql',
 '20260910_profile_identity.sql','20260910_demo_sessions.sql','20260910_invite_links.sql',
 '20260910_currencies.sql','20260910_company_currency.sql','20260910_global_identity.sql',
 '20260910_client_lifecycle.sql','20260911_agency_reports.sql','20260911_invite_link_metrics.sql',
 '20260911_invite_link_details.sql'
];

async function fixture(){
 const pg=new PGlite();
 await pg.exec(execFileSync('git',['show','HEAD:schema.sql'],{cwd:new URL('.',import.meta.url),encoding:'utf8'}));
 for(const file of migrations)await pg.exec(await fs.readFile(new URL('./migrations/'+file,import.meta.url),'utf8'));
 const query=(sql,values)=>pg.query(sql,values),db={query,connect:async()=>({query,release(){}})};
 const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
 const owner=(await query("insert into users(email,password_hash) values('flow-owner@example.invalid','!') returning id")).rows[0].id;
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,owner]);
 const actor={id:owner,organization_id:org,role:'owner'};
 async function call(path,method='GET',payload={}){
  let result;
  await inviteLinks({req:{method,headers:{origin:'https://app.scaleparaguay.com'},socket:{remoteAddress:'test'}},res:{},url:new URL('https://test'+path),db,session:async()=>actor,body:async()=>payload,send:(_,status,data)=>{result={status,...data};},appUrl:'https://app.scaleparaguay.com'});
  return result;
 }
 async function make(mode,role){
  const link=await call('/api/agency/invite-links','POST',{mode,role});
  assert.equal(link.status,200);
  return {...link,token:new URL(link.url).searchParams.get('token')};
 }
 async function claim(link,email,name=email){
  await query('begin');
  try{const result=await claimInvite({query},link.id,{email,name,email_verified:true});await query('commit');return result;}
  catch(error){await query('rollback');throw error;}
 }
 return {pg,query,org,call,make,claim};
}

test('a suspended member remains pending until an owner approves the fresh invitation',async()=>{
 const f=await fixture();
 try{
  const user=(await f.query("insert into users(email,password_hash) values('suspended-flow@example.invalid','!') returning id")).rows[0].id;
  await f.query("insert into organization_members(organization_id,user_id,role,active,removed_at) values($1,$2,'viewer',false,now())",[f.org,user]);
  const link=await f.make('approval','production');
  assert.equal((await f.claim(link,'suspended-flow@example.invalid','Persona suspendida')).pending,true);
  const requests=(await f.call('/api/agency/access-requests')).requests;
  assert.equal(requests.length,1);
  assert.equal(requests[0].status,'pending');
  assert.equal(requests[0].unavailableReason,null);
  const membership=(await f.query('select role,active,removed_at is not null as removed from organization_members where organization_id=$1 and user_id=$2',[f.org,user])).rows[0];
  assert.deepEqual(membership,{role:'viewer',active:false,removed:true},'claiming the link must not silently reactivate or change the suspended membership');
 }finally{await f.pg.close();}
});

test('a single-use link is consumed when a suspended member is approved',async()=>{
 const f=await fixture();
 try{
  const user=(await f.query("insert into users(email,password_hash) values('single-suspended@example.invalid','!') returning id")).rows[0].id;
  await f.query("insert into organization_members(organization_id,user_id,role,active,removed_at) values($1,$2,'viewer',false,now())",[f.org,user]);
  const link=await f.make('single','editor');
  await resolveInvite({query:f.query},link.token);
  assert.equal((await f.claim(link,'single-suspended@example.invalid')).pending,true);
  const request=(await f.query('select id from agency_access_requests where link_id=$1 and user_id=$2',[link.id,user])).rows[0];
  assert.equal((await f.call('/api/agency/access-requests/'+request.id,'PATCH',{action:'approve'})).status,200);
  const persisted=(await f.query('select used_at,account_count from agency_invite_links where id=$1',[link.id])).rows[0];
  assert.ok(persisted.used_at,'approval must consume a single-use link');
  assert.equal(persisted.account_count,1);
  await assert.rejects(()=>f.claim(link,'second-person@example.invalid'),{status:410});
 }finally{await f.pg.close();}
});

test('a multiuser link keeps independent requests and counts only approved accounts',async()=>{
 const f=await fixture();
 try{
  const link=await f.make('approval','finance');
  await f.claim(link,'first-multi@example.invalid','Primera persona');
  await f.claim(link,'first-multi@example.invalid','Primera persona actualizada');
  await f.claim(link,'second-multi@example.invalid','Segunda persona');
  let requests=(await f.call('/api/agency/access-requests')).requests;
  assert.equal(requests.length,2,'reopening the same link with the same account must not duplicate the request');
  assert.equal((await f.query('select count(*)::int as count from organization_members where invite_link_id=$1',[link.id])).rows[0].count,0);
  assert.equal((await f.call('/api/agency/access-requests/'+requests[0].id,'PATCH',{action:'approve'})).status,200);
  let persisted=(await f.query('select used_at,account_count from agency_invite_links where id=$1',[link.id])).rows[0];
  assert.equal(persisted.used_at,null,'a multiuser link must remain available after the first approval');
  assert.equal(persisted.account_count,1);
  requests=(await f.call('/api/agency/access-requests')).requests;
  assert.equal(requests.length,1);
  assert.equal((await f.call('/api/agency/access-requests/'+requests[0].id,'PATCH',{action:'approve'})).status,200);
  persisted=(await f.query('select used_at,account_count from agency_invite_links where id=$1',[link.id])).rows[0];
  assert.equal(persisted.used_at,null);
  assert.equal(persisted.account_count,2);
  assert.equal((await f.query("select count(*)::int as count from organization_members m join users u on u.id=m.user_id where m.invite_link_id=$1 and m.role='finance' and m.active=true",[link.id])).rows[0].count,2);
 }finally{await f.pg.close();}
});
