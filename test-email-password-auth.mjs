// node --experimental-vm-modules test-email-password-auth.mjs
// Local credential enrollment is exercised against the real migrations and
// handlers; delivery is captured in memory, never sent to an email provider.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {PGlite} from '@electric-sql/pglite';
import {emailPasswordAuth} from './email-password-auth.js';

const root=new URL('.',import.meta.url),pg=new PGlite();
await pg.exec(execFileSync('git',['show','HEAD:schema.sql'],{cwd:root,encoding:'utf8'}));
const source=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
const init=source.slice(source.indexOf('async function init()'),source.indexOf('async function provisionOwner('));
const migrations=[...init.matchAll(/['"](?:migrations\/)?(\d{8}_[\w-]+\.sql)['"]/g)].map(m=>m[1]).filter(f=>f!=='20260908_dadoo_hub.sql');
for(const file of migrations)await pg.exec(await fs.readFile(new URL('./migrations/'+file,import.meta.url),'utf8'));
const query=(sql,values)=>pg.query(sql,values),db={query,connect:async()=>({query,release(){}})};
const rows=async(sql,values)=>(await query(sql,values)).rows;
const sent=[];let session=0;
async function call(path,payload){
 let response;
 await emailPasswordAuth({
  req:{method:'POST'},res:{},url:new URL('https://admin.scaleparaguay.com'+path),db,
  body:async()=>payload,send:(_,status,data,headers={})=>{response={status,data,headers};},
  sendVerification:async(email,token)=>{sent.push({email,token});return true;},
  emailAvailable:true,
  cookie:(name,value)=>`${name}=${value}`,id:()=>`test-session-${++session}`,
 });
 return response;
}
const password='PruebaSegura!2026';
try{
 const baseline=(await rows('select count(*)::int as count from users'))[0].count;
 const unavailable=await emailPasswordAuth({req:{method:'POST'},res:{},url:new URL('https://admin.scaleparaguay.com/api/auth/password/register'),db,body:async()=>({email:'disabled@example.invalid',password,company:'Disabled email',currency:'USD',consent:true}),send:(_,status,data)=>{assert.equal(status,503);assert.match(data.error,/todavía no está disponible/);},sendVerification:async()=>{throw Error('must not send')},emailAvailable:false,cookie:()=>'',id:()=>''});
 assert.equal(unavailable,true);assert.equal((await rows("select count(*)::int as count from users where email='disabled@example.invalid'"))[0].count,0);
 const weak=await call('/api/auth/password/register',{email:'weak@example.invalid',password:'weakpassword',company:'Agencia segura',currency:'USD',consent:true});
 assert.equal(weak.status,400);assert.equal((await rows('select count(*)::int as count from users'))[0].count,baseline);

 // A bad invitation is rejected before an account or verification record exists.
 const invalid=await call('/api/auth/password/invitations/register',{token:'a'.repeat(43),email:'bad-invite@example.invalid',password,full_name:'Bad Invite'});
 assert.equal(invalid.status,410);assert.equal((await rows("select count(*)::int as count from users where email='bad-invite@example.invalid'"))[0].count,0);

 // Trial enrollment has no agency, membership or active session before the
 // emailed proof is consumed. The raw token is never persisted.
 const start=await call('/api/auth/password/register',{email:'trial-password@example.invalid',password,full_name:'Trial Password',company:'Agencia Password',currency:'PYG',consent:true});
 assert.equal(start.status,202);const trialMail=sent.at(-1);assert.equal(trialMail.email,'trial-password@example.invalid');
 assert.equal((await rows("select count(*)::int as count from organizations where name='Agencia Password'"))[0].count,0);
 assert.equal((await rows('select count(*)::int as count from auth_email_verifications'))[0].count,1);
 assert.equal((await rows('select count(*)::int as count from auth_email_verifications where token_hash=$1',[trialMail.token]))[0].count,0);
 const trial=await call('/api/auth/password/verify',{token:trialMail.token});
 assert.equal(trial.status,200);assert.equal(trial.data.trial,true);assert.match(trial.headers['Set-Cookie'],/^scale_session=test-session-/);
 const trialOrg=(await rows("select id from organizations where name='Agencia Password'"))[0];assert(trialOrg);
 assert.equal((await rows('select count(*)::int as count from organization_members where organization_id=$1',[trialOrg.id]))[0].count,1);
 assert.equal((await rows("select count(*)::int as count from users where email='trial-password@example.invalid' and email_verified_at is not null"))[0].count,1);
 assert.equal((await call('/api/auth/password/verify',{token:trialMail.token})).status,400,'verification links are one use');

 // Valid invite is previewed before the user exists, then revalidated while
 // claiming it. No access is granted before email verification.
 const org=(await rows("select id from organizations where slug='scale'"))[0].id;
 const owner=(await rows("insert into users(email,password_hash,email_verified_at) values('owner-password@example.invalid','!',now()) returning id"))[0].id;
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,owner]);
 const inviteToken=crypto.randomBytes(32).toString('base64url');
 await query("insert into agency_invite_links(organization_id,token_hash,role,mode,created_by,expires_at) values($1,$2,'editor','single',$3,now()+interval '1 day')",[org,crypto.createHash('sha256').update(inviteToken).digest('hex'),owner]);
 const inviteStart=await call('/api/auth/password/invitations/register',{token:inviteToken,email:'invite-password@example.invalid',password,full_name:'Invitada Password'});
 assert.equal(inviteStart.status,202);const inviteMail=sent.at(-1);
 const invited=(await rows("select id from users where email='invite-password@example.invalid'"))[0];assert(invited);
 assert.equal((await rows('select count(*)::int as count from organization_members where user_id=$1',[invited.id]))[0].count,0);
 const accepted=await call('/api/auth/password/verify',{token:inviteMail.token});
 assert.equal(accepted.status,200);assert.equal(accepted.data.pending,false);
 assert.deepEqual((await rows('select role,active from organization_members where organization_id=$1 and user_id=$2',[org,invited.id]))[0],{role:'editor',active:true});
 const link=(await rows('select used_at from agency_invite_links where token_hash=$1',[crypto.createHash('sha256').update(inviteToken).digest('hex')]))[0];assert(link.used_at);
 const verifiedInviteToken=crypto.randomBytes(32).toString('base64url');await query("insert into agency_invite_links(organization_id,token_hash,role,mode,created_by,expires_at) values($1,$2,'viewer','single',$3,now()+interval '1 day')",[org,crypto.createHash('sha256').update(verifiedInviteToken).digest('hex'),owner]);
 assert.equal((await call('/api/auth/password/invitations/register',{token:verifiedInviteToken,email:'invite-password@example.invalid',password,full_name:'Invitada Password'})).status,409);

 // A correct-password, unverified enrollment may move from a revoked invite
 // to a new valid one. The old proof is invalidated atomically; mismatches and
 // verified accounts retain the existing 409 behavior.
 const staleToken=crypto.randomBytes(32).toString('base64url'),replacementToken=crypto.randomBytes(32).toString('base64url');
 const addInvite=async token=>(await rows("insert into agency_invite_links(organization_id,token_hash,role,mode,created_by,expires_at) values($1,$2,'viewer','single',$3,now()+interval '1 day') returning id",[org,crypto.createHash('sha256').update(token).digest('hex'),owner]))[0];
 const stale=await addInvite(staleToken),replacement=await addInvite(replacementToken),rebindEmail='rebind-invite@example.invalid';
 assert.equal((await call('/api/auth/password/invitations/register',{token:staleToken,email:rebindEmail,password,full_name:'Rebound Invite'})).status,202);const staleMail=sent.at(-1);
 await query('update agency_invite_links set revoked_at=now() where id=$1',[stale.id]);
 assert.equal((await call('/api/auth/password/invitations/register',{token:replacementToken,email:rebindEmail,password:'OtraClaveSegura!2026',full_name:'Rebound Invite'})).status,409);
 assert.equal((await call('/api/auth/password/invitations/register',{token:replacementToken,email:rebindEmail,password,full_name:'Rebound Invite'})).status,202);const replacementMail=sent.at(-1);
 assert.equal((await rows('select invite_link_id from auth_email_verifications v join users u on u.id=v.user_id where u.email=$1 and v.used_at is null',[rebindEmail]))[0].invite_link_id,replacement.id);
 assert.equal((await call('/api/auth/password/verify',{token:staleMail.token})).status,400);
 assert.equal((await call('/api/auth/password/verify',{token:replacementMail.token})).status,200);
 const expiredToken=crypto.randomBytes(32).toString('base64url'),expiredReplacementToken=crypto.randomBytes(32).toString('base64url'),expiredEmail='expired-rebind@example.invalid';
 const expired=await addInvite(expiredToken),expiredReplacement=await addInvite(expiredReplacementToken);
 assert.equal((await call('/api/auth/password/invitations/register',{token:expiredToken,email:expiredEmail,password,full_name:'Expired Rebind'})).status,202);await query("update agency_invite_links set expires_at=now()-interval '1 second' where id=$1",[expired.id]);
 assert.equal((await call('/api/auth/password/invitations/register',{token:expiredReplacementToken,email:expiredEmail,password,full_name:'Expired Rebind'})).status,202);
 assert.equal((await rows('select invite_link_id from auth_email_verifications v join users u on u.id=v.user_id where u.email=$1 and v.used_at is null',[expiredEmail]))[0].invite_link_id,expiredReplacement.id);

 // Resend response is deliberately neutral and creates a replacement, not an
 // additional valid token.
 const pending=await call('/api/auth/password/register',{email:'resend@example.invalid',password,company:'Agencia resend',currency:'USD',consent:true});assert.equal(pending.status,202);
 const before=sent.length;const resend=await call('/api/auth/password/verification/request',{email:'resend@example.invalid'});assert.equal(resend.status,202);assert.equal(sent.length,before+1);
 assert.equal((await rows("select count(*)::int as count from auth_email_verifications v join users u on u.id=v.user_id where u.email='resend@example.invalid' and v.used_at is null"))[0].count,1);
 console.log('PASS: robust local passwords, pre-write invitation validation, verified trial/invite activation, single-use verification and neutral resend');
}finally{await pg.close();}
