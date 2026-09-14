import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {accountSecurity,googleRecentAuthBinding,issueGoogleRecentAuthHandoff} from './account-security.js';

const pg=new PGlite();
const read=file=>fs.readFile(new URL(file,import.meta.url),'utf8');
await pg.exec(await read('./schema.sql'));
await pg.exec(await read('./migrations/20260908_google_oauth.sql'));
await pg.exec(await read('./migrations/20260911_google_profile_photo.sql'));
await pg.exec(await read('./migrations/20260910_demo_sessions.sql'));
await pg.exec(await read('./migrations/20260910_invite_links.sql'));
await pg.exec('alter table organization_members add column if not exists active boolean not null default true; alter table organization_members add column if not exists removed_at timestamptz;');
await pg.exec(await read('./migrations/20260914_secure_deletion.sql'));
await pg.exec(await read('./migrations/20260914_destructive_email_reauth.sql'));

const query=(sql,params)=>pg.query(sql,params);
const db={query,connect:async()=>({query,release(){}})};
const cookie=(name,value,maxAge)=>`${name}=${value}; Max-Age=${maxAge}`;
const parseCookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(value=>{const i=value.indexOf('=');return [value.slice(0,i).trim(),value.slice(i+1)];}));
const body=async req=>req.payload||{};
const insert=async(sql,params)=>(await query(sql+' returning id',params)).rows[0].id;
const hashToken=value=>crypto.createHash('sha256').update(value).digest('hex');
let sessionCounter=0;

async function makeUser(email,{password='CorrectHorse9',googleOnly=false}={}){
 const passwordHash=googleOnly?'!google-trial-no-password':await bcrypt.hash(password,4);
 return insert('insert into users(email,password_hash) values($1,$2)',[email,passwordHash]);
}
async function makeOrg(slug,name=slug){return insert('insert into organizations(slug,name) values($1,$2)',[slug,name]);}
async function member(org,user,role='owner'){await query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3)',[org,user,role]);}
async function newSession(user,org){
 const id=(++sessionCounter).toString(16).padStart(64,'0');
 await query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '1 day')",[id,user,org]);
 return id;
}
function actor(user,org,role='owner'){return {id:user,organization_id:org,role};}
const rateCounts=new Map();
async function rateLimit(_db,key,max){const count=(rateCounts.get(key)||0)+1;rateCounts.set(key,count);return count<=max;}
async function call(path,{method='POST',payload={},as=null,sessionId='',throttle=async()=>true}={}){
 const result={status:0,data:null,headers:{}};
 await accountSecurity({
  req:{method,headers:{cookie:sessionId?`scale_session=${sessionId}`:''},payload,socket:{remoteAddress:'test'}},
  res:{},url:new URL(path,'https://api.example.invalid'),db,session:async()=>as,body,parseCookies,cookie,throttle,
  emailAvailable:true,sendDestructiveEmailCode:async(email,code)=>{sentCodes.push({email,code});return true;},
  send:(_res,status,data,headers={})=>{result.status=status;result.data=data;result.headers=headers;}
 });
 return result;
}
const sentCodes=[];
async function previewAccount(as,payload={memberships:[{organizationId:'attacker-controlled'}],count:999,role:'owner'}){
 const response=await call('/api/auth/account/deletion/preview',{payload,as});
 assert.equal(response.status,200,JSON.stringify(response.data));return response.data.preview;
}
async function previewCompany(as,org){
 const response=await call(`/api/auth/organizations/${org}/deletion/preview`,{as});
 assert.equal(response.status,200,JSON.stringify(response.data));return response.data.preview;
}
async function passwordProof(as,preview,password='CorrectHorse9'){
 return call('/api/auth/account/recent-auth/password',{payload:{previewId:preview.id,password},as});
}
async function executeAccount(as,preview,proof,confirmation=preview.confirmation){
 return call('/api/auth/account/deletion',{payload:{previewId:preview.id,recentAuthProof:proof,confirmation},as});
}
async function executeCompany(as,org,preview,proof,confirmation=preview.confirmation){
 return call(`/api/auth/organizations/${org}/deletion`,{payload:{previewId:preview.id,recentAuthProof:proof,confirmation},as});
}

assert.equal(await accountSecurity({req:{method:'GET'},url:new URL('https://api.example.invalid/api/auth/account/recent-auth/google/start'),db}),false,'Google start must fall through to the verified server OAuth route');

// Authentication is mandatory and previews are derived only from database state.
let response=await call('/api/auth/account/deletion/preview',{as:null});
assert.equal(response.status,401);
const derivedUser=await makeUser('derived@example.invalid');
const derivedSole=await makeOrg('derived-sole','Derived Sole');
const derivedShared=await makeOrg('derived-shared','Derived Shared');
const derivedPeer=await makeUser('derived-peer@example.invalid');
await member(derivedSole,derivedUser,'owner');
await member(derivedShared,derivedUser,'editor');
await member(derivedShared,derivedPeer,'owner');
const retainedSoleClient=await insert("insert into agency_clients(organization_id,name) values($1,'Retained sole tenant data')",[derivedSole]);
let as=actor(derivedUser,derivedSole);
let preview=await previewAccount(as);
assert.equal(preview.confirmation,'Eliminar');
assert.equal(preview.memberships.length,2);
assert.deepEqual(preview.memberships.map(row=>row.consequence).sort(),['membership_deactivation','organization_soft_delete']);
assert.equal(preview.memberships.find(row=>row.organizationId===String(derivedShared)).activeMemberCount,2);
assert.equal(preview.account.tenantDataWillBeRetained,true);
assert.equal(preview.executable,true);

// Password recent-auth is preview-bound; exact confirmation is enforced without consuming proof.
response=await passwordProof(as,preview,'wrong');
assert.equal(response.status,401);assert.equal(response.data.code,'PASSWORD_REAUTH_FAILED');
response=await passwordProof(as,preview);
assert.equal(response.status,200);let proof=response.data.proof;
response=await executeAccount(as,preview,proof,'eliminar mi cuenta');
assert.equal(response.status,400);assert.equal(response.data.code,'CONFIRMATION_MISMATCH');
assert.equal((await query('select deleted_at from users where id=$1',[derivedUser])).rows[0].deleted_at,null);

// Account deletion soft-deletes sole-member organizations, removes only this user from shared organizations,
// anonymizes the account, and revokes every session atomically.
const derivedSessionA=await newSession(derivedUser,derivedSole);
await newSession(derivedUser,derivedShared);
response=await executeAccount(as,preview,proof);
assert.equal(response.status,200,JSON.stringify(response.data));
assert.deepEqual(response.data.organizationsSoftDeleted,[String(derivedSole)]);
assert.deepEqual(response.data.membershipsDeactivated,[String(derivedSole),String(derivedShared)]);
assert.equal((await query('select active,deleted_at is not null as deleted from organizations where id=$1',[derivedSole])).rows[0].active,false);
assert.equal((await query('select count(*)::int as count from agency_clients where id=$1',[retainedSoleClient])).rows[0].count,1);
assert.equal((await query('select active from organizations where id=$1',[derivedShared])).rows[0].active,true);
assert.deepEqual((await query('select active,removed_at is not null as removed from organization_members where organization_id=$1 and user_id=$2',[derivedSole,derivedUser])).rows[0],{active:false,removed:true},'Account deletion must soft-deactivate the sole active owner membership with its organization.');
assert.equal((await query('select active,removed_at is not null as removed from organization_members where organization_id=$1 and user_id=$2',[derivedShared,derivedUser])).rows[0].active,false);
assert.equal((await query('select active from organization_members where organization_id=$1 and user_id=$2',[derivedShared,derivedPeer])).rows[0].active,true);
assert.equal((await query('select count(*)::int as count from sessions where user_id=$1',[derivedUser])).rows[0].count,0);
const anonymized=(await query('select email,password_hash,deleted_at is not null as deleted,anonymized_at is not null as anonymized from users where id=$1',[derivedUser])).rows[0];
assert.match(anonymized.email,/^deleted\+/);assert.equal(anonymized.password_hash,'!deleted-account');assert.equal(anonymized.deleted,true);assert.equal(anonymized.anonymized,true);
assert.match(response.headers['Set-Cookie'],/^scale_session=;/);
void derivedSessionA;

// A last active owner in a shared organization blocks the whole account operation with no partial changes.
const blockedUser=await makeUser('blocked@example.invalid');
const blockedSole=await makeOrg('blocked-sole');
const blockedShared=await makeOrg('blocked-shared');
const blockedPeer=await makeUser('blocked-peer@example.invalid');
await member(blockedSole,blockedUser,'owner');
await member(blockedShared,blockedUser,'owner');
await member(blockedShared,blockedPeer,'editor');
as=actor(blockedUser,blockedShared);
preview=await previewAccount(as);
assert.equal(preview.executable,false);
assert.deepEqual(preview.blockers.map(row=>row.code),['LAST_ACTIVE_OWNER']);
response=await passwordProof(as,preview);
assert.equal(response.status,409);assert.equal(response.data.code,'LAST_ACTIVE_OWNER');
assert.equal((await query('select active from organizations where id=$1',[blockedSole])).rows[0].active,true);
assert.equal((await query('select active from organization_members where user_id=$1 order by organization_id',[blockedUser])).rows.every(row=>row.active),true);
assert.equal((await query('select deleted_at from users where id=$1',[blockedUser])).rows[0].deleted_at,null);

// The company in a deletion URL must be the authenticated session organization, even when the actor owns both.
const scopedTargetUser=await makeUser('scoped-target@example.invalid');
const sessionOrganization=await makeOrg('scoped-session-org');
const differentOrganization=await makeOrg('scoped-different-org');
await member(sessionOrganization,scopedTargetUser,'owner');
await member(differentOrganization,scopedTargetUser,'owner');
as=actor(scopedTargetUser,sessionOrganization);
response=await call(`/api/auth/organizations/${differentOrganization}/deletion/preview`,{as});
assert.equal(response.status,403);assert.equal(response.data.code,'DELETION_SCOPE_MISMATCH');
assert.equal((await query('select active from organizations where id=$1',[differentOrganization])).rows[0].active,true);

// Direct API callers cannot use the company deletion endpoints against a demo organization.
const demoOwner=await makeUser('demo-owner@example.invalid');
const demoOrganization=await makeOrg('demo-deletion-protected');
await query('update organizations set demo_owner_user_id=$1 where id=$2',[demoOwner,demoOrganization]);
await member(demoOrganization,demoOwner,'owner');
as=actor(demoOwner,demoOrganization);
response=await call(`/api/auth/organizations/${demoOrganization}/deletion/preview`,{as});
assert.equal(response.status,403);assert.equal(response.data.code,'DEMO_ORGANIZATION_DELETE_FORBIDDEN');
response=await call('/api/auth/account/deletion/preview',{as});
assert.equal(response.status,403);assert.equal(response.data.code,'DEMO_ACCOUNT_DELETE_FORBIDDEN');
assert.equal((await query('select active from organizations where id=$1',[demoOrganization])).rows[0].active,true);

// Direct API callers cannot delete demo guests, even from an otherwise real organization.
const demoGuest=await makeUser('demo-guest-delete@example.invalid');
const demoGuestOrganization=await makeOrg('demo-guest-delete-org');await member(demoGuestOrganization,demoGuest,'owner');
await query('update users set is_demo_guest=true where id=$1',[demoGuest]);
as=actor(demoGuest,demoGuestOrganization);
response=await call('/api/auth/account/deletion/preview',{as});
assert.equal(response.status,403);assert.equal(response.data.code,'DEMO_ACCOUNT_DELETE_FORBIDDEN');
assert.equal((await query('select deleted_at from users where id=$1',[demoGuest])).rows[0].deleted_at,null);

// Final execution re-derives demo state, so a preview/proof issued before a demo transition cannot be replayed.
const demoTransitionUser=await makeUser('demo-transition@example.invalid');
const demoTransitionOrganization=await makeOrg('demo-transition-org');await member(demoTransitionOrganization,demoTransitionUser,'owner');
as=actor(demoTransitionUser,demoTransitionOrganization);preview=await previewAccount(as);
response=await passwordProof(as,preview);assert.equal(response.status,200);proof=response.data.proof;
await query('update organizations set demo_owner_user_id=$1 where id=$2',[demoTransitionUser,demoTransitionOrganization]);
response=await passwordProof(as,preview);
assert.equal(response.status,403);assert.equal(response.data.code,'DEMO_ACCOUNT_DELETE_FORBIDDEN');
response=await executeAccount(as,preview,proof);
assert.equal(response.status,403);assert.equal(response.data.code,'DEMO_ACCOUNT_DELETE_FORBIDDEN');
assert.equal((await query('select deleted_at from users where id=$1',[demoTransitionUser])).rows[0].deleted_at,null);
assert.equal((await query('select active from organizations where id=$1',[demoTransitionOrganization])).rows[0].active,true);

// A membership race after re-authentication makes the preview stale and leaves all rows untouched.
const staleUser=await makeUser('stale@example.invalid');
const staleOrg=await makeOrg('stale-org');
const stalePeer=await makeUser('stale-peer@example.invalid');
await member(staleOrg,staleUser,'owner');
as=actor(staleUser,staleOrg);
preview=await previewAccount(as);
response=await passwordProof(as,preview);assert.equal(response.status,200);proof=response.data.proof;
await member(staleOrg,stalePeer,'viewer');
response=await executeAccount(as,preview,proof);
assert.equal(response.status,409);assert.equal(response.data.code,'DELETION_PREVIEW_STALE');
assert.equal((await query('select active from organizations where id=$1',[staleOrg])).rows[0].active,true);
assert.equal((await query('select active from organization_members where organization_id=$1 and user_id=$2',[staleOrg,staleUser])).rows[0].active,true);
assert.equal((await query('select consumed_at from destructive_auth_proofs where token_hash=$1',[(await import('node:crypto')).createHash('sha256').update(proof).digest('hex')])).rows[0].consumed_at,null);

// Displayed organization names are part of account-preview freshness.
const renamedUser=await makeUser('renamed@example.invalid');
const renamedOrg=await makeOrg('renamed-org','Before Rename');
await member(renamedOrg,renamedUser,'owner');as=actor(renamedUser,renamedOrg);
preview=await previewAccount(as);response=await passwordProof(as,preview);assert.equal(response.status,200);proof=response.data.proof;
await query("update organizations set name='After Rename' where id=$1",[renamedOrg]);
response=await executeAccount(as,preview,proof);
assert.equal(response.status,409);assert.equal(response.data.code,'DELETION_PREVIEW_STALE');
assert.equal((await query('select active from organizations where id=$1',[renamedOrg])).rows[0].active,true);
assert.equal((await query('select deleted_at from users where id=$1',[renamedUser])).rows[0].deleted_at,null);

// An account-bound preview/proof cannot be replayed against a company endpoint.
const scopedUser=await makeUser('scope@example.invalid');
const scopedOrg=await makeOrg('scope-org');await member(scopedOrg,scopedUser,'owner');
as=actor(scopedUser,scopedOrg);preview=await previewAccount(as);
response=await passwordProof(as,preview);assert.equal(response.status,200);proof=response.data.proof;
response=await executeCompany(as,scopedOrg,preview,proof);
assert.equal(response.status,409);assert.equal(response.data.code,'DELETION_SCOPE_MISMATCH');
assert.equal((await query('select active from organizations where id=$1',[scopedOrg])).rows[0].active,true);

// Company deletion requires an active owner, a fresh preview, recent auth, and exact server-authored confirmation.
const companyOwner=await makeUser('company-owner@example.invalid');
const companyMember=await makeUser('company-member@example.invalid');
const companyOrg=await makeOrg('company-org','Acme Norte');
await member(companyOrg,companyOwner,'owner');await member(companyOrg,companyMember,'editor');
const retainedCompanyClient=await insert("insert into agency_clients(organization_id,name) values($1,'Retained company tenant data')",[companyOrg]);
const memberActor=actor(companyMember,companyOrg,'editor');
response=await call(`/api/auth/organizations/${companyOrg}/deletion/preview`,{as:memberActor});
assert.equal(response.status,403);assert.equal(response.data.code,'ORGANIZATION_DELETE_FORBIDDEN');
as=actor(companyOwner,companyOrg);
preview=await previewCompany(as,companyOrg);
assert.equal(preview.confirmation,'Eliminar');
assert.equal(preview.organization.activeMemberCount,2);
assert.equal(preview.consequences.tenantDataWillBeRetained,true);
response=await passwordProof(as,preview);assert.equal(response.status,200);proof=response.data.proof;
const ownerSession=await newSession(companyOwner,companyOrg);
await newSession(companyMember,companyOrg);
response=await executeCompany(as,companyOrg,preview,proof,'eliminar');
assert.equal(response.status,400);assert.equal(response.data.code,'CONFIRMATION_MISMATCH');
assert.equal((await query('select active from organizations where id=$1',[companyOrg])).rows[0].active,true);
response=await executeCompany(as,companyOrg,preview,proof);
assert.equal(response.status,200,JSON.stringify(response.data));
assert.equal((await query('select active,deleted_at is not null as deleted from organizations where id=$1',[companyOrg])).rows[0].active,false);
assert.equal((await query('select count(*)::int as count from agency_clients where id=$1',[retainedCompanyClient])).rows[0].count,1);
assert.equal((await query('select bool_and(not active) as all_inactive from organization_members where organization_id=$1',[companyOrg])).rows[0].all_inactive,true);
assert.equal((await query('select count(*)::int as count from sessions where organization_id=$1',[companyOrg])).rows[0].count,0);
assert.match(response.headers['Set-Cookie'],/^scale_session=;/);
response=await executeCompany(as,companyOrg,preview,proof);
assert.equal(response.status,409);assert.equal(response.data.code,'DELETION_PREVIEW_INVALID');
assert.notEqual((await query('select consumed_at from destructive_auth_proofs where token_hash=$1',[hashToken(proof)])).rows[0].consumed_at,null);
void ownerSession;

// Password-backed accounts cannot enter or complete the Google destructive re-auth path.
const passwordGoogleUser=await makeUser('password-google-reject@example.invalid');
const passwordGoogleOrg=await makeOrg('password-google-reject-org');await member(passwordGoogleOrg,passwordGoogleUser,'owner');
as=actor(passwordGoogleUser,passwordGoogleOrg);preview=await previewAccount(as);
await assert.rejects(()=>googleRecentAuthBinding(db,passwordGoogleUser,preview.id),error=>error.code==='GOOGLE_REAUTH_NOT_ALLOWED');
await assert.rejects(()=>issueGoogleRecentAuthHandoff(db,{userId:passwordGoogleUser,previewHash:hashToken(preview.id),profile:{email:'password-google-reject@example.invalid',email_verified:true}}),error=>error.code==='GOOGLE_REAUTH_NOT_ALLOWED');
const forgedGoogleTicket=crypto.randomBytes(32).toString('base64url');
await query("insert into destructive_google_handoffs(token_hash,preview_token_hash,user_id,expires_at) values($1,$2,$3,now()+interval '60 seconds')",[hashToken(forgedGoogleTicket),hashToken(preview.id),passwordGoogleUser]);
response=await call('/api/auth/account/recent-auth/google/complete',{payload:{ticket:forgedGoogleTicket},as});
assert.equal(response.status,409);assert.equal(response.data.code,'GOOGLE_REAUTH_NOT_ALLOWED');
assert.equal((await query('select count(*)::int as count from destructive_google_handoffs where token_hash=$1',[hashToken(forgedGoogleTicket)])).rows[0].count,1,'Rejected completion must not consume its handoff');

// Google-only accounts cannot use password re-auth; only a verified, matching Google profile can mint a one-time handoff.
const googleUser=await makeUser('google-only@example.invalid',{googleOnly:true});
const googleOrg=await makeOrg('google-org');
await member(googleOrg,googleUser,'owner');
as=actor(googleUser,googleOrg);
preview=await previewAccount(as);
response=await passwordProof(as,preview,'anything');
assert.equal(response.status,409);assert.equal(response.data.code,'PASSWORD_REAUTH_UNAVAILABLE');
const binding=await googleRecentAuthBinding(db,googleUser,preview.id);
await assert.rejects(()=>issueGoogleRecentAuthHandoff(db,{userId:googleUser,previewHash:binding.previewHash,profile:{email:'google-only@example.invalid',email_verified:false}}),error=>error.code==='GOOGLE_IDENTITY_UNVERIFIED');
await assert.rejects(()=>issueGoogleRecentAuthHandoff(db,{userId:googleUser,previewHash:binding.previewHash,profile:{email:'attacker@example.invalid',email_verified:true}}),error=>error.code==='GOOGLE_IDENTITY_MISMATCH');
const handoff=await issueGoogleRecentAuthHandoff(db,{userId:googleUser,previewHash:binding.previewHash,profile:{email:'google-only@example.invalid',email_verified:true}});
response=await call('/api/auth/account/recent-auth/google/complete',{payload:{ticket:handoff.ticket},as});
assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.method,'google');
proof=response.data.proof;
response=await executeAccount(as,preview,proof);
assert.equal(response.status,200);
response=await call('/api/auth/account/recent-auth/google/complete',{payload:{ticket:handoff.ticket},as});
assert.equal(response.status,401);assert.equal(response.data.code,'GOOGLE_REAUTH_INVALID');

// Passwordless users can confirm a preview through a one-use, preview-bound
// email code. Raw codes are sent only to the mailer and are never persisted.
const emailUser=await makeUser('email-reauth@example.invalid',{googleOnly:true});
const emailOrg=await makeOrg('email-reauth-org');await member(emailOrg,emailUser,'owner');
as=actor(emailUser,emailOrg);preview=await previewAccount(as);
response=await call('/api/auth/account/recent-auth/email/request',{payload:{previewId:preview.id},as});
assert.equal(response.status,202);const firstEmail=sentCodes.at(-1);assert.equal(firstEmail.email,'email-reauth@example.invalid');assert.match(firstEmail.code,/^\d{8}$/);
assert.equal((await query('select count(*)::int as count from destructive_email_challenges where code_hash=$1',[firstEmail.code])).rows[0].count,0);
response=await call('/api/auth/account/recent-auth/email/complete',{payload:{previewId:preview.id,code:firstEmail.code},as});
assert.equal(response.status,200);assert.equal(response.data.method,'email');proof=response.data.proof;
response=await executeAccount(as,preview,proof);assert.equal(response.status,200);
response=await call('/api/auth/account/recent-auth/email/complete',{payload:{previewId:preview.id,code:firstEmail.code},as});
assert.equal(response.status,401);assert.equal(response.data.code,'EMAIL_REAUTH_INVALID');

// Resends replace the previous code; a code cannot cross preview/user boundaries.
const emailReplayUser=await makeUser('email-replay@example.invalid',{googleOnly:true});
const emailReplayOrg=await makeOrg('email-replay-org');await member(emailReplayOrg,emailReplayUser,'owner');
as=actor(emailReplayUser,emailReplayOrg);preview=await previewAccount(as);
response=await call('/api/auth/account/recent-auth/email/request',{payload:{previewId:preview.id},as});assert.equal(response.status,202);const staleEmail=sentCodes.at(-1);
response=await call('/api/auth/account/recent-auth/email/request',{payload:{previewId:preview.id},as});assert.equal(response.status,202);const currentEmail=sentCodes.at(-1);assert.notEqual(staleEmail.code,currentEmail.code);
response=await call('/api/auth/account/recent-auth/email/complete',{payload:{previewId:preview.id,code:staleEmail.code},as});assert.equal(response.status,401);
const anotherPreview=await previewAccount(as);
response=await call('/api/auth/account/recent-auth/email/complete',{payload:{previewId:anotherPreview.id,code:currentEmail.code},as});assert.equal(response.status,401);
const otherEmailUser=await makeUser('email-other@example.invalid',{googleOnly:true});
response=await call('/api/auth/account/recent-auth/email/complete',{payload:{previewId:preview.id,code:currentEmail.code},as:actor(otherEmailUser,emailReplayOrg)});assert.equal(response.status,401);

// Wrong numeric codes are throttled, while expiration never issues a proof.
const emailExpiryUser=await makeUser('email-expiry@example.invalid',{googleOnly:true});
const emailExpiryOrg=await makeOrg('email-expiry-org');await member(emailExpiryOrg,emailExpiryUser,'owner');
as=actor(emailExpiryUser,emailExpiryOrg);preview=await previewAccount(as);
response=await call('/api/auth/account/recent-auth/email/request',{payload:{previewId:preview.id},as});assert.equal(response.status,202);const expiryEmail=sentCodes.at(-1);
await query('update destructive_email_challenges set expires_at=now()-interval \'1 second\' where preview_token_hash=$1',[hashToken(preview.id)]);
response=await call('/api/auth/account/recent-auth/email/complete',{payload:{previewId:preview.id,code:expiryEmail.code},as});assert.equal(response.status,401);
const emailThrottleUser=await makeUser('email-throttle@example.invalid',{googleOnly:true});
const emailThrottleOrg=await makeOrg('email-throttle-org');await member(emailThrottleOrg,emailThrottleUser,'owner');
as=actor(emailThrottleUser,emailThrottleOrg);preview=await previewAccount(as);await call('/api/auth/account/recent-auth/email/request',{payload:{previewId:preview.id},as});
for(let attempt=0;attempt<5;attempt++){response=await call('/api/auth/account/recent-auth/email/complete',{payload:{previewId:preview.id,code:'00000000'},as,throttle:rateLimit});assert.equal(response.status,401);}
response=await call('/api/auth/account/recent-auth/email/complete',{payload:{previewId:preview.id,code:'00000000'},as,throttle:rateLimit});assert.equal(response.status,429);assert.equal(response.data.code,'EMAIL_REAUTH_RATE_LIMITED');

// A late database failure rolls back organization, membership, session, preview and proof mutations.
const rollbackUser=await makeUser('rollback@example.invalid');
const rollbackOrg=await makeOrg('rollback-org');
await member(rollbackOrg,rollbackUser,'owner');
const rollbackSession=await newSession(rollbackUser,rollbackOrg);
as=actor(rollbackUser,rollbackOrg);
preview=await previewAccount(as);
response=await passwordProof(as,preview);assert.equal(response.status,200);proof=response.data.proof;
await pg.exec(`create function reject_account_anonymization() returns trigger language plpgsql as $$
begin if new.deleted_at is not null and old.deleted_at is null then raise exception 'forced rollback'; end if; return new; end $$;
create trigger reject_account_anonymization before update on users for each row execute function reject_account_anonymization();`);
response=await executeAccount(as,preview,proof);
assert.equal(response.status,500);
await pg.exec('drop trigger reject_account_anonymization on users; drop function reject_account_anonymization();');
assert.equal((await query('select active,deleted_at from organizations where id=$1',[rollbackOrg])).rows[0].active,true);
assert.equal((await query('select active,removed_at from organization_members where organization_id=$1 and user_id=$2',[rollbackOrg,rollbackUser])).rows[0].active,true);
assert.equal((await query('select count(*)::int as count from sessions where id=$1',[rollbackSession])).rows[0].count,1);
assert.equal((await query('select consumed_at from destructive_action_previews where token_hash=$1',[crypto.createHash('sha256').update(preview.id).digest('hex')])).rows[0].consumed_at,null);
assert.equal((await query('select consumed_at from destructive_auth_proofs where token_hash=$1',[crypto.createHash('sha256').update(proof).digest('hex')])).rows[0].consumed_at,null);

await pg.close();
console.log('PASS: secure server-derived account/company deletion previews, authorization, recent auth, race rejection, soft deletion, session revocation and transactional rollback');
