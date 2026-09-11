import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {inviteLinks,resolveInvite,claimInvite} from './invite-links.js';
import {publicExperience} from './public-experience.js';
const pg=new PGlite();await pg.exec(await fs.readFile('schema.sql','utf8'));
for(const f of ['20260908_treasury_ledger.sql','20260908_google_oauth.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql','20260910_productivity.sql','20260910_profile_identity.sql','20260910_demo_sessions.sql','20260910_invite_links.sql','20260910_currencies.sql'])await pg.exec(await fs.readFile('migrations/'+f,'utf8'));
await pg.exec(await fs.readFile('migrations/20260910_invite_links.sql','utf8'));await pg.exec(await fs.readFile('migrations/20260910_currencies.sql','utf8'));
for(const file of ['20260910_company_currency.sql','20260910_global_identity.sql','20260910_project_assignees.sql','20260910_inventory_reservations.sql','20260910_work_checklists.sql'])await pg.exec(await fs.readFile('migrations/'+file,'utf8'));
const query=(s,v)=>pg.query(s,v),db={query,connect:async()=>({query,release(){}})};
for(const file of ['20260910_client_lifecycle.sql','20260911_agency_reports.sql','20260911_invite_link_metrics.sql','20260911_invite_link_details.sql'])await pg.exec(await fs.readFile('migrations/'+file,'utf8'));
const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
const owner=(await query("insert into users(email,password_hash) values('owner@example.invalid','!') returning id")).rows[0].id;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,owner]);
const actor={id:owner,organization_id:org,role:'owner'};let result;
async function call(path,method='GET',b={},user=actor,handler=inviteLinks){result=null;const req={method,headers:{origin:'https://sistema.scaleparaguay.com'},socket:{remoteAddress:'test'}};await handler({req,res:{},url:new URL('https://test'+path),db,session:async()=>user,body:async()=>b,send:(_,status,data,headers)=>{result={status,...data,headers};},appUrl:'https://app.scaleparaguay.com',cookie:(n,v)=>n+'='+v,parseCookies:()=>({scale_session:'none'})});return result;}
const links='/api/agency/invite-links',requests='/api/agency/access-requests';
assert.equal((await call(links,'POST',{role:'owner',mode:'single'},{...actor,role:'admin'})).status,403);
assert.equal((await call(links,'POST',{role:'editor',mode:'single'},{...actor,role:'viewer'})).status,403);
assert.equal((await call(links,'POST',{role:'editor',mode:'single'},{...actor,demo_owner_user_id:owner})).status,403);
async function make(mode='single',role='editor'){const r=await call(links,'POST',{role,mode});assert.equal(r.status,200);const token=new URL(r.url).searchParams.get('token');assert((await resolveInvite(db,token)).id);return {...r,token};}
async function claim(link,email){await query('begin');try{const r=await claimInvite({query},link.id,{email,name:'Test Person',email_verified:true});await query('commit');return r;}catch(e){await query('rollback');throw e;}}
const one=await make();const granted=await claim(one,'one@example.invalid');assert.equal((await query('select role from organization_members where user_id=$1',[granted.userId])).rows[0].role,'editor');
const suspended=(await query("insert into users(email,password_hash) values('suspended@example.invalid','!') returning id")).rows[0].id;await query("insert into organization_members(organization_id,user_id,role,active,removed_at) values($1,$2,'viewer',false,now())",[org,suspended]);const suspendedLink=await make('single','production');const pendingSuspended=await claim(suspendedLink,'suspended@example.invalid');assert.equal(pendingSuspended.pending,true);assert.equal((await query('select active from organization_members where user_id=$1 and organization_id=$2',[suspended,org])).rows[0].active,false);const suspendedRequest=(await query("select id from agency_access_requests where user_id=$1",[suspended])).rows[0].id;assert.equal((await call(requests+'/'+suspendedRequest,'PATCH',{action:'approve'})).status,200);assert.equal((await query('select active,role from organization_members where user_id=$1 and organization_id=$2',[suspended,org])).rows[0].role,'production');assert.equal((await query('select used_at from agency_invite_links where id=$1',[suspendedLink.id])).rows[0].used_at!==null,true);await assert.rejects(()=>claim(suspendedLink,'another@example.invalid'),{status:410});
await assert.rejects(()=>claim(one,'two@example.invalid'),{status:410});await assert.rejects(()=>resolveInvite(db,one.token),{status:410});
const many=await make('approval','finance');assert.equal((await claim(many,'many@example.invalid')).pending,true);await claim(many,'many@example.invalid');
let rows=(await call(requests)).requests;assert.equal(rows.length,1);assert.equal((await query("select count(*)::int as n from organization_members m join users u on u.id=m.user_id where u.email='many@example.invalid'")).rows[0].n,0);
assert.equal((await call(requests+'/'+rows[0].id,'PATCH',{action:'approve'},{...actor,organization_id:99999})).status,404);
assert.equal((await call(requests+'/'+rows[0].id,'PATCH',{action:'approve'})).status,200);assert.equal((await call(requests+'/'+rows[0].id,'PATCH',{action:'approve'})).status,409);
assert.equal((await query("select m.role from organization_members m join users u on u.id=m.user_id where u.email='many@example.invalid'")).rows[0].role,'finance');
assert.equal((await claim(many,'third@example.invalid')).pending,true);rows=(await call(requests)).requests;
await call(links+'/'+many.id,'DELETE');assert.equal((await call(requests+'/'+rows[0].id,'PATCH',{action:'approve'})).status,409);
await assert.rejects(()=>claim(many,'fourth@example.invalid'),{status:410});
const ownerLink=await make('single','owner');await claim(ownerLink,'one@example.invalid');assert.equal((await query('select role from organization_members where user_id=$1',[granted.userId])).rows[0].role,'editor');
assert(!(await call(links)).links.some(l=>l.token_hash));assert((await call(links)).links.some(l=>l.url));
const before=(await query('select count(*)::int as n from agency_clients where organization_id=$1',[org])).rows[0].n;
const demo=await call('/api/demo/start','POST',{},null,publicExperience);assert.equal(demo.status,201);assert(demo.headers['Set-Cookie']);
const demoOrg=(await query('select id from organizations where demo_owner_user_id is not null order by id desc limit 1')).rows[0].id;
assert.equal((await query('select count(*)::int as n from agency_clients where organization_id=$1',[demoOrg])).rows[0].n,20);
assert.equal((await query('select count(distinct role)::int as n from organization_members where organization_id=$1',[demoOrg])).rows[0].n,6);
assert.equal((await query('select count(*)::int as n from agency_clients where organization_id=$1',[org])).rows[0].n,before);
assert.equal((await call('/api/demo/role','POST',{role:'owner'},actor,publicExperience)).status,403);
const payload={name:'QA Test',company:'Fictional QA',email:'qa@example.invalid',consent:true};
assert.equal((await call('/api/public/contact','POST',{...payload,consent:false},null,publicExperience)).status,400);
assert.equal((await call('/api/public/contact','POST',payload,null,publicExperience)).status,202);await call('/api/public/contact','POST',payload,null,publicExperience);
assert.equal((await query("select count(*)::int as n from agency_leads where organization_id=$1 and email='qa@example.invalid'",[org])).rows[0].n,1);
for(const currency of ['EUR','BRL','ARS','MXN'])await query("insert into bank_accounts(organization_id,name,account_type,currency) values($1,$2,'bank',$2)",[demoOrg,currency]);
await assert.rejects(()=>query("insert into bank_accounts(organization_id,name,account_type,currency) values($1,'Bad','bank','XXX')",[demoOrg]));
// Public status is authoritative and does not leak tenant or member data when unavailable.
const previewLink=await make('approval');
const previewPath='/api/invitations/preview?token='+previewLink.token;
let preview=await call(previewPath,'GET',{},null);
assert.equal(preview.link_status,'active');assert(preview.expires_at);
assert.equal(preview.organization_name,'Scale Strategy Group');
const clicks=(await query('select click_count from agency_invite_links where id=$1',[previewLink.id])).rows[0].click_count;
for(const [sql,state] of [
 ["update agency_invite_links set expires_at=now()-interval '1 second' where id=$1",'expired'],
 ["update agency_invite_links set revoked_at=now() where id=$1",'revoked'],
 ["update agency_invite_links set revoked_at=null,used_at=now() where id=$1",'used']
]){
 await query(sql,[previewLink.id]);preview=await call(previewPath,'GET',{},null);
 assert.equal(preview.status,410);assert.equal(preview.link_status,state);
 assert.equal(preview.organization_name,undefined);assert.equal(preview.role,undefined);
}
assert.equal((await query('select click_count from agency_invite_links where id=$1',[previewLink.id])).rows[0].click_count,clicks);
assert.equal((await call('/api/invitations/preview?token='+'z'.repeat(43),'GET',{},null)).link_status,'unavailable');
await pg.close();console.log('PASS: single-use consumption, approval without access, revocation, tenant/role boundaries, public status and expiration, no role escalation, private public Demo, contact dedup and supported currencies');
