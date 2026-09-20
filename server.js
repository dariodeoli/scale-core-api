import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { operations } from './operations.js';
import { agencyCore } from './agency-core.js';
import { suite } from './agency-suite.js';
import { passwordAccess, throttle } from './password-access.js';
import {emailPasswordAuth} from './email-password-auth.js';
import {loginOrganization} from './default-organization.js';
import { financeControls } from './finance-controls.js';
import { contentReview } from './content-review.js';
import { recordLifecycle, visibleRecord } from './record-lifecycle.js';
import { invitationEmail,accessGrantedEmail,resetEmail,verificationEmail,destructiveReauthEmail } from './invitation-email.js';
import { trialStartedEmail,paymentFailedEmail } from './billing-email.js';
import {financialForecast} from './forecast.js';
import {commercialLifecycle} from './commercial-lifecycle.js';
import {reports} from './reports.js';
import {projectAssignees} from './project-assignees.js';
import {enrichWorkOrderAssignees} from './work-order-assignees.js';
import {startMaintenance} from './maintenance.js';
import {inventoryReservations} from './inventory-reservations.js';
import {pipelineStages} from './pipeline-stages.js';
import {studioReservations} from './studio-reservations.js';
import {workChecklists} from './work-checklists.js';
import {ensurePersonalIdentity,ensurePersonalIdentityInTransaction} from './identity-session.js';
import {googleProfilePhoto,rememberGooglePhoto} from './google-profile-photo.js';
import {liveVisitors,startLiveVisitorCleanup} from './live-visitors.js';
import { productivity } from './productivity.js';
import {weeklyReports} from './weekly-reports.js';
import {rucLookup,assertUniqueClientRuc,rucLookupConfig,createRucProvider} from './ruc-lookup.js';
import {workOrderLinks} from './work-order-links.js';
import {presence} from './presence.js';
import {demoOrganization} from './demo-session.js';
import {inviteLinks,resolveInvite,claimInvite,accessRequestState} from './invite-links.js';
import {publicExperience} from './public-experience.js';
import {notifications} from './notifications.js';
import {automationApi,startAutomation} from './automation.js';
import {subscriptionBilling,subscriptionState} from './subscription-billing.js';
import {trialDetails,trialDetailsFromInput,registerTrial} from './trial-registration.js';
import {platformAdmin,bootstrapInitialPlatformAdmin,ensurePlatformOwnerAdmin} from './platform-admin.js';
import {applyPendingMigrations} from './migrations-runner.mjs';
import {rolePermissions,roleCan} from './permissions.js';
import {createEmailDelivery,publicEmailDeliveryStatus} from './email-delivery.js';
import {acceptClientPortalGoogleInvite,clientPortal,clientPortalGoogleInvite,clientPortalResetEmail,clientPortalInviteEmail,clientPortalUrl} from './client-portal.js';
import {accountSecurity,googleRecentAuthBinding,issueGoogleRecentAuthHandoff} from './account-security.js';

const { Pool } = pg;
const port = Number(process.env.PORT || 3000);
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
 log: (message, duration) => { if(typeof duration==='number'&&duration>250)console.info(JSON.stringify({event:'slow_query',duration_ms:Math.round(duration),message:typeof message==='string'?message.slice(0,200):''})); } });
const root = path.dirname(fileURLToPath(import.meta.url));
const release=JSON.parse(await fs.readFile(path.join(root,'release-version.json'),'utf8'));
const rucConfig=rucLookupConfig();
const rucProvider=createRucProvider({baseUrl:rucConfig.providerUrl,timeoutMs:rucConfig.timeoutMs});
const bootstrapEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const bootstrapPassword = process.env.ADMIN_PASSWORD || '';
const scaleOsOwnerEmail = (process.env.SCALE_OS_OWNER_EMAIL || '').trim().toLowerCase();
const scaleOsOwnerPassword = process.env.SCALE_OS_OWNER_PASSWORD || '';
const initialPlatformAdminEmail = process.env.SCALE_INITIAL_PLATFORM_ADMIN_EMAIL || '';
const dadooOwnerEmail = (process.env.DADOO_OWNER_EMAIL || '').trim().toLowerCase();
const dadooOwnerPassword = process.env.DADOO_OWNER_PASSWORD || '';
const googleClientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const googleRedirectUri = (process.env.GOOGLE_REDIRECT_URI || 'https://admin.scaleparaguay.com/api/auth/google/callback').trim();
const appUrl = (process.env.APP_URL || 'https://app.scaleparaguay.com').replace(/\/$/, '');
const resendApiKey = process.env.RESEND_API_KEY || '';
const invitationFrom = process.env.EMAIL_FROM || '';
const weemRelayUrl = process.env.WEEM_EMAIL_RELAY_URL || '';
const weemRelayToken = process.env.WEEM_EMAIL_RELAY_TOKEN || '';
const emailDelivery=createEmailDelivery({apiKey:resendApiKey,from:invitationFrom,appUrl,weemRelayUrl,weemRelayToken});
const allowedOrigin = process.env.PUBLIC_ORIGIN || 'https://scaleparaguay.com';
const allowedOrigins = new Set([allowedOrigin, 'https://scaleparaguay.com', 'https://www.scaleparaguay.com', 'https://admin.scaleparaguay.com', 'https://api.scaleparaguay.com', 'https://app.scaleparaguay.com', 'https://dadoocapital.com', 'https://www.dadoocapital.com', 'https://admin.dadoocapital.com']);
allowedOrigins.add('https://sistema.scaleparaguay.com');
allowedOrigins.add('https://cliente.scaleparaguay.com');
let databaseReady = false;

const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); return true; };
const cookie = (name, value, maxAge) => `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax; Domain=.scaleparaguay.com`;
// The OAuth state cookie must cross hosts: it is issued through the app/portal
// proxy and consumed at the admin-host callback. Domain-scoped with the same
// HttpOnly/Secure/SameSite posture as the rest of the session cookies.
const oauthStateCookie = (value, maxAge) => `scale_oauth_state=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax; Domain=.scaleparaguay.com`;
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => { const i=v.indexOf('='); const raw=v.slice(i+1); let value=raw; try{value=decodeURIComponent(raw);}catch{/* Keep the raw value; a malformed cookie must not fail the whole request. */} return [v.slice(0,i).trim(), value]; }));
const body = async (req) => { let s=''; for await (const c of req) {s += c;if(s.length>1048576)throw Object.assign(new Error('Solicitud demasiado grande'),{status:413});} if(!s)return {}; try{return JSON.parse(s);}catch{throw Object.assign(new Error('Cuerpo JSON inválido'),{status:400});} };
const id = () => crypto.randomBytes(32).toString('hex');
async function sendInvitation(email, organizationName, role) {
  return emailDelivery.send({to:email,message:invitationEmail({email,organizationName,role,appUrl})});
}
async function sendAccessGranted(email, organizationName, role) {
  return emailDelivery.send({to:email,message:accessGrantedEmail({email,organizationName,role,appUrl}),idempotencyKey:'access-granted-'+crypto.createHash('sha256').update(email.toLowerCase()).digest('hex')});
}
async function sendBillingMessage(email,message,key){return emailDelivery.send({to:email,message,idempotencyKey:key});}
const sendTrialEmail=(email,organizationName,trialEndsOn)=>sendBillingMessage(email,trialStartedEmail({email,organizationName,trialEndsOn,appUrl}),'trial-started-'+crypto.createHash('sha256').update(email.toLowerCase()).digest('hex'));
const sendPaymentFailed=(email,organizationName)=>sendBillingMessage(email,paymentFailedEmail({organizationName,appUrl}),'payment-failed-'+crypto.createHash('sha256').update(email.toLowerCase()+new Date().toISOString().slice(0,10)).digest('hex'));
async function sendReset(email,token){return emailDelivery.send({to:email,message:resetEmail({token,appUrl}),idempotencyKey:'reset-'+crypto.createHash('sha256').update(token).digest('hex')});}
async function sendVerification(email,token){return emailDelivery.send({to:email,message:verificationEmail({token,appUrl}),idempotencyKey:'verify-'+crypto.createHash('sha256').update(token).digest('hex')});}
async function sendDestructiveEmailCode(email,code){return emailDelivery.send({to:email,message:destructiveReauthEmail({code}),idempotencyKey:'destructive-reauth-'+crypto.createHash('sha256').update(code).digest('hex')});}
async function sendClientPortalReset(email,token){return emailDelivery.send({to:email,message:clientPortalResetEmail({token}),idempotencyKey:'client-portal-reset-'+crypto.createHash('sha256').update(token).digest('hex')});}
// La clave incluye el texto (que lleva el token del enlace): re-invitar al mismo
// correo y cliente genera un token nuevo y, antes, reutilizaba la clave y no enviaba nada.
async function sendClientPortalInvite(email,message){return emailDelivery.send({to:email,message,idempotencyKey:'client-portal-invite-'+crypto.createHash('sha256').update(email.toLowerCase()+message.text).digest('hex')});}
async function runOptionalMigration(filename,client=db) {
  try {
    await client.query(await fs.readFile(path.join(root, 'migrations', filename), 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
}
async function init() {
  const migration=await db.connect();
  try{
    await migration.query('begin');
    await migration.query("select pg_advisory_xact_lock(hashtextextended('scale-core-schema',0))");
    await migration.query(await fs.readFile(path.join(root,'schema.sql'),'utf8'));
    await runOptionalMigration('20260908_dadoo_hub.sql',migration);
    for(const filename of ['20260908_client_payment_status.sql','20260908_treasury_ledger.sql','20260908_google_oauth.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql'])await migration.query(await fs.readFile(path.join(root,'migrations',filename),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_productivity.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_profile_identity.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_demo_sessions.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_notifications.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_client_links.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_client_lifecycle.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_ruc_lookup.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_presence.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_invite_links.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_currencies.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_company_currency.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_live_visitors.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_global_identity.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260911_demo_owner_identity.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_project_assignees.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_inventory_reservations.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260910_work_checklists.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260911_subscriptions.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260913_pagaya_subscription_handoff.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260911_trial_registration.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260914_google_pending_trial_registration.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260911_agency_reports.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260911_drive_links.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260911_invite_link_metrics.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260911_invite_link_details.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260911_google_profile_photo.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260911_default_login_organization.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260911_weekly_reports.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260912_urgency.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260911_assignment_notifications.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260912_comment_mentions.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260912_inventory_verifications.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260912_platform_admin.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260912_platform_admin_bootstrap.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260913_platform_admin_vertical_slice.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260912_email_password_auth.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260912_studio_reservations.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260912_client_portal.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260912_client_portal_google_oauth.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260912_client_portal_password_resets.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260913_client_portal_vertical_slice.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260913_inventory_advanced_traceability.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260913_ruc_collaboration.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260912_account_security.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260914_secure_deletion.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260914_destructive_email_reauth.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260914_client_commercial_lifecycle.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260914_inventory_storage_locations.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260914_salary_forecast.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260914_client_terms_and_planned_expenses.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260914_role_permissions.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260914_production_traceability.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_optional_commission_terms.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_billing_cadence_and_coupons.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_coupon_free_days.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_coupon_redemption_days.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_client_invoice_flags.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_planned_expense_kind.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_expenses.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_client_terms_end_date.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_platform_admin_roles.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_platform_owner_admin.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_inventory_photos.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_inventory_location_pipeline.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_inventory_category_icons.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260915_salary_override_signed.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260916_identity_photo_removal.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260917_identity_admin_photo.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260918_collaborator_role_and_project_archive.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260919_collaborator_role_member_checks.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260919_pipeline_stages.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260919_inventory_value_maintenance.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260920_platform_coupon_shape.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260920_currency_widening.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260921_users_role_default.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260921_role_permissions_audit.sql'),'utf8'));
    await migration.query(await fs.readFile(path.join(root,'migrations/20260921_platform_extend_idempotency.sql'),'utf8'));
    await applyPendingMigrations(migration, path.join(root,'migrations'), {firstRun: 'baseline'});
    await migration.query('commit');
  }catch(error){await migration.query('rollback');throw error;}finally{migration.release();}
  async function provisionOwner(email, password) {
    if (!email || !password) return;
    const hash = await bcrypt.hash(password, 12);
    const user = await db.query('insert into users(email,password_hash,email_verified_at,role) values($1,$2,now(),$3) on conflict(email) do update set email=excluded.email,email_verified_at=coalesce(users.email_verified_at,now()) returning id', [email, hash, 'viewer']);
    await db.query("insert into organization_members(organization_id,user_id,role) select id,$1,'owner' from organizations where slug='scale' on conflict(organization_id,user_id) do nothing", [user.rows[0].id]);
  }
  await provisionOwner(bootstrapEmail, bootstrapPassword);
  await provisionOwner(scaleOsOwnerEmail, scaleOsOwnerPassword);
  await provisionOwnerForOrganization(dadooOwnerEmail, dadooOwnerPassword, 'dadoo-capital');
  await bootstrapInitialPlatformAdmin(db,initialPlatformAdminEmail);
  await ensurePlatformOwnerAdmin(db,initialPlatformAdminEmail);
}
async function provisionOwnerForOrganization(email, password, slug) {
  if (!email || !password) return;
  const hash = await bcrypt.hash(password, 12);
  const user = await db.query('insert into users(email,password_hash,email_verified_at,role) values($1,$2,now(),$3) on conflict(email) do update set password_hash=excluded.password_hash,email_verified_at=coalesce(users.email_verified_at,now()) returning id', [email, hash, 'viewer']);
  await db.query("insert into organization_members(organization_id,user_id,role) select id,$1,'owner' from organizations where slug=$2 on conflict(organization_id,user_id) do update set role='owner'", [user.rows[0].id, slug]);
}
const sessionCache = new WeakMap();
let permissionDefaultsLogged = false;
async function session(req) {
  if (sessionCache.has(req)) return sessionCache.get(req);
  const value = await resolveSession(req);
  sessionCache.set(req, value);
  return value;
}
async function resolveSession(req) {
  const token = parseCookies(req).scale_session;
  if (!token) return null;
  const r = await db.query("select u.id,u.email,exists(select 1 from user_personal_identities pi where pi.user_id=u.id) as has_personal_identity,up.full_name,up.photo_url,coalesce(settings.default_currency,'PYG') as default_currency,m.role,m.organization_id,o.slug as organization_slug,o.name as organization_name,o.demo_owner_user_id,o.demo_source_id from sessions s join users u on u.id=s.user_id join organization_members m on m.user_id=u.id and m.organization_id=s.organization_id join organizations o on o.id=m.organization_id left join organization_person_identity up on up.user_id=u.id and up.organization_id=m.organization_id left join agency_settings settings on settings.organization_id=m.organization_id where s.id=$1 and s.expires_at>now() and o.active=true and m.active=true and m.removed_at is null and not exists(select 1 from account_closure_requests acr where acr.user_id=u.id and acr.cancelled_at is null and acr.recoverable_until>now()) and (o.demo_owner_user_id is null or (o.demo_owner_user_id=u.id and o.demo_expires_at>now()))", [token]);
  const user=r.rows[0]||null;
  if(user&&!user.has_personal_identity&&!user.demo_owner_user_id&&!user.demo_source_id&&user.organization_slug!=='scale-demo-controles-20260908'){
    await ensurePersonalIdentity(db,user.id,user.organization_id);
    const identity=(await db.query('select full_name,photo_url from organization_person_identity where user_id=$1 and organization_id=$2',[user.id,user.organization_id])).rows[0];
    if(!identity)return null;
    Object.assign(user,identity);
  }
  if(user){delete user.has_personal_identity;
   try{
    const overrides=(await db.query('select capability,allowed from agency_role_permissions where organization_id=$1 and role=$2',[user.organization_id,user.role])).rows;
    if(overrides.length)user.capabilities=Object.fromEntries(overrides.map(row=>[row.capability,row.allowed]));
   }catch(error){if(!permissionDefaultsLogged){permissionDefaultsLogged=true;console.info(JSON.stringify({event:'permission_defaults_fallback',error:String(error?.message||error)}));}}
  }
  if(user?.demo_owner_user_id){const preview=(await db.query('select demo_role from sessions where id=$1',[token])).rows[0];if(preview?.demo_role)user.role=preview.demo_role;}
  if(user?.organization_slug==='scale-demo-controles-20260908'){
    const c=await db.connect();try{
      await c.query('begin');
      const current=(await c.query('select demo_key from sessions where id=$1 for update',[token])).rows[0];
      if(!current){await c.query('rollback');return null;}
      const org=await demoOrganization(c,{userId:user.id,sourceId:user.organization_id,demoKey:current.demo_key});
      await c.query('update sessions set organization_id=$1 where id=$2',[org,token]);await c.query('commit');
    }catch(e){await c.query('rollback');throw e;}finally{c.release();}
    return resolveSession(req);
  }
  return user;
}
const subscriptionCache = new WeakMap();
async function requestSubscription(req, actor) {
  if (subscriptionCache.has(req)) return subscriptionCache.get(req);
  const value = await subscriptionState(db, actor);
  subscriptionCache.set(req, value);
  return value;
}
async function auditContext(client,user,req){await client.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);}
async function auditedQuery(user,req,sql,params){const c=await db.connect();try{await c.query('begin');await auditContext(c,user,req);const r=await c.query(sql,params);await c.query('commit');return r;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
function security(res, extra={}) { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()'); res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains'); res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' data:; img-src 'self' data:; script-src 'self' 'unsafe-inline' data:; connect-src 'self' https://scaleparaguay.com https://www.scaleparaguay.com https://app.scaleparaguay.com"); Object.entries(extra).forEach(([k,v])=>res.setHeader(k,v)); }
function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Vary', 'Origin');
  return true;
}
const server = http.createServer(async (req,res) => {
  security(res);
  if (!cors(req, res)) return send(res,403,{error:'Origen no permitido'});
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const startedAt = Date.now();
  const requestId = crypto.randomBytes(8).toString('hex');
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if(url.pathname.startsWith('/api/'))res.setHeader('Cache-Control','no-store');
    if(await subscriptionBilling({req,res,url,db,session,body,send,sendPaymentFailed}))return;
    if(await platformAdmin({req,res,url,db,session,body,send,bootstrapValue:initialPlatformAdminEmail}))return;
    // Billing is separate from membership: suspended owners retain billing,
    // logout and company switching, but no private operational reads/writes.
    if(url.pathname.startsWith('/api/agency/')||url.pathname==='/api/metrics'||url.pathname==='/api/hub/overview'||(url.pathname==='/api/auth/organizations'&&req.method==='POST')){
      const actor=await session(req);
      if(actor){const subscription=await requestSubscription(req,actor);if(!subscription.hasAccess)return send(res,402,{code:'SUBSCRIPTION_REQUIRED',error:'La suscripción está suspendida. El dueño puede regularizar el pago sin perder los datos.',subscription});}
    }
    // La matriz de permisos es una lectura/escritura privada más: va después del
    // corte por suscripción, como el resto de /api/agency/*.
    if(await rolePermissions({req,res,url,db,session,body,send}))return;
    if(url.pathname==='/api/invitations/status'&&req.method==='GET'){
      const r=(await db.query(`select o.name as organization_name,u.email,l.role,r.status,l.revoked_at,l.used_at,l.expires_at>now() as link_valid,o.active as organization_active,exists(select 1 from organization_members m where m.organization_id=o.id and m.user_id=u.id and m.active=true and m.removed_at is null) as existing_member from sessions s join users u on u.id=s.user_id join organizations o on o.id=s.organization_id join agency_invite_links l on l.organization_id=o.id join agency_access_requests r on r.link_id=l.id and r.user_id=u.id where s.id=$1 and s.expires_at>now() order by r.created_at desc,r.id desc limit 1`,[parseCookies(req).scale_session||''])).rows[0];
      if(!r)return send(res,401,{error:'Ingresá con Google para ver tu solicitud'});
      const approved=await session(req),effective=accessRequestState(r);
      return send(res,200,{organization_name:r.organization_name,email:r.email,role:approved?.role||r.role,status:approved?'approved':r.status==='approved'?'unavailable':effective.status,unavailableReason:approved?null:r.status==='approved'?'access_removed':effective.unavailableReason});
    }
    if(await liveVisitors({req,res,url,db,session,send}))return;
    if(await financialForecast({req,res,url,db,session,send}))return;
    if(await commercialLifecycle({req,res,url,db,session,body,send}))return;
    if(await projectAssignees({req,res,url,db,session,body,send}))return;
    if(await inventoryReservations({req,res,url,db,session,body,send}))return;
    if(await workChecklists({req,res,url,db,session,body,send}))return;
    if(await publicExperience({req,res,url,db,session,body,send,cookie,parseCookies}))return;
    if(await clientPortal({req,res,url,db,session,body,send,sendPasswordReset:sendClientPortalReset,sendInvite:sendClientPortalInvite,emailAvailable:emailDelivery.status.available}))return;
    if(await inviteLinks({req,res,url,db,session,body,send,appUrl,sendAccessGranted}))return;
    if(req.method!=='GET'){
      const actor=await session(req);
      if(actor?.demo_owner_user_id&&(url.pathname==='/api/auth/organizations'||url.pathname==='/api/events'||/\/(share|client-review)$/.test(url.pathname)||/\/budgets\/\d+\/publish$/.test(url.pathname)))return send(res,403,{error:'El Demo no comparte datos públicamente ni crea empresas o eventos externos.'});
    }
    if(url.pathname.startsWith('/api/agency/members')&&req.method!=='GET'){const actor=await session(req);if(actor?.demo_owner_user_id)return send(res,403,{error:'El Demo no envía invitaciones ni cambia accesos reales. Usá Equipo en tu agencia.'});}
    if(await reports({req,res,url,db,session,body,send}))return;
    if(await recordLifecycle({req,res,url,db,session,send}))return;
    if(url.pathname==='/api/auth/email-status'&&req.method==='GET')return send(res,200,{email:publicEmailDeliveryStatus(emailDelivery.status)});
    if(await emailPasswordAuth({req,res,url,db,body,send,sendVerification,emailAvailable:emailDelivery.status.available,cookie,id}))return;
    if(await passwordAccess({req,res,url,db,body,send,sendReset,emailAvailable:emailDelivery.status.available}))return;
    if(await accountSecurity({req,res,url,db,session,body,send,parseCookies,cookie,throttle,sendDestructiveEmailCode,emailAvailable:emailDelivery.status.available}))return;
    if(await financeControls({req,res,url,db,session,body,send}))return;
    if(await contentReview({req,res,url,db,session,body,send}))return;
    if(await productivity({req,res,url,db,session,body,send}))return;
    if(await weeklyReports({req,res,url,db,session,body,send}))return;
    if(await rucLookup({req,res,url,db,session,body,send,provider:rucProvider,config:rucConfig}))return;
    if(await workOrderLinks({req,res,url,db,session,body,send}))return;
    if(await presence({req,res,url,db,session,body,send,sessionKey:req=>crypto.createHash('sha256').update(parseCookies(req).scale_session||'').digest('hex')}))return;
    if(await notifications({req,res,url,db,session,body,send}))return;
    if(await automationApi({req,res,url,db,session,body,send}))return;
    if(await studioReservations({req,res,url,db,session,body,send}))return;
    if(await pipelineStages({req,res,url,db,session,body,send}))return;
    if(await suite({req,res,url,db,session,body,send,sendInvitation,sendAccessGranted}))return;
    if (await operations({req,res,url,db,session,body,send,sendInvitation})) return;
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(307, { Location: 'https://app.scaleparaguay.com/superadmin' });
      return res.end();
    }
    if (url.pathname === '/health') return send(res,databaseReady ? 200 : 503,{ok:databaseReady,database:databaseReady ? 'ready' : 'initializing',release});
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      // Un cuerpo nulo o con tipos inesperados es entrada inválida (400), nunca 500.
      const input=(await body(req))||{};
      const e=(typeof input.email==='string'?input.email:'').trim().toLowerCase(),password=typeof input.password==='string'?input.password:'';
      if(!e||!password)return send(res,400,{error:'Ingresá tu correo y contraseña'});
      if(!await throttle(db,'login:'+e,30))return send(res,429,{error:'Demasiados intentos. Esperá 15 minutos.'});
      const r=await db.query('select id,password_hash,email_verified_at,is_demo_guest from users where email=$1',[e]);
      if (!r.rows[0]||!r.rows[0].email_verified_at||r.rows[0].is_demo_guest||!(await bcrypt.compare(password,r.rows[0].password_hash))) return send(res,401,{error:'Credenciales inválidas'});
      if((await db.query('select 1 from account_closure_requests where user_id=$1 and cancelled_at is null and recoverable_until>now()',[r.rows[0].id])).rows.length)return send(res,403,{code:'ACCOUNT_CLOSURE_PENDING',error:'Esta cuenta tiene un cierre solicitado. Podés recuperarla desde Recuperar cuenta.'});
      r.rows[0].organization_id=(await loginOrganization(db,{userId:r.rows[0].id}))?.organization_id;
      if (!r.rows[0].organization_id) return send(res,403,{error:'Usuario sin organización asignada'});
      const token=id(); await db.query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '7 days')",[token,r.rows[0].id,r.rows[0].organization_id]);
      return send(res,200,{ok:true},{'Set-Cookie':cookie('scale_session',token,604800)});
    }
    if (url.pathname === '/api/auth/providers' && req.method === 'GET') {
      return send(res,200,{google:Boolean(googleClientId && googleClientSecret)});
    }
    if (url.pathname === '/api/client-portal/auth/google/start' && req.method === 'GET') {
      if (!googleClientId || !googleClientSecret) return send(res,503,{error:'Google OAuth aún no está configurado'});
      const inviteToken=url.searchParams.get('token');
      const invite=inviteToken?await clientPortalGoogleInvite(db,inviteToken):null;
      const state=id();
      await db.query("insert into oauth_states(state,organization_slug,redirect_uri,expires_at,client_portal_login,client_portal_invite_id) values($1,$2,$3,now()+interval '10 minutes',true,$4)",[state,'',googleRedirectUri,invite?.id||null]);
      const params=new URLSearchParams({client_id:googleClientId,redirect_uri:googleRedirectUri,response_type:'code',scope:'openid email profile',state,prompt:'select_account'});
      res.writeHead(302,{Location:`https://accounts.google.com/o/oauth2/v2/auth?${params}`,'Set-Cookie':oauthStateCookie(state,600)});return res.end();
    }
    if (url.pathname === '/api/auth/account/recent-auth/google/start' && req.method === 'GET') {
      if (!googleClientId || !googleClientSecret) return send(res,503,{code:'GOOGLE_REAUTH_UNAVAILABLE',error:'Google OAuth aún no está configurado'});
      const user=await session(req);if(!user)return send(res,401,{error:'No autenticado'});
      try{
        const binding=await googleRecentAuthBinding(db,user.id,url.searchParams.get('previewId')||'');
        const state=id();
        await db.query("insert into oauth_states(state,organization_slug,redirect_uri,expires_at,recent_auth_preview_hash,recent_auth_user_id) values($1,'',$2,now()+interval '10 minutes',$3,$4)",[state,googleRedirectUri,binding.previewHash,user.id]);
        const params=new URLSearchParams({client_id:googleClientId,redirect_uri:googleRedirectUri,response_type:'code',scope:'openid email profile',state,prompt:'select_account'});
        res.writeHead(302,{Location:`https://accounts.google.com/o/oauth2/v2/auth?${params}`,'Set-Cookie':oauthStateCookie(state,600)});return res.end();
      }catch(error){return send(res,error.status||500,{...(error.code?{code:error.code}:{}),error:error.status?error.message:'No se pudo iniciar la verificación con Google.'});}
    }
    if (url.pathname === '/api/auth/google/start' && req.method === 'GET') {
      if (!googleClientId || !googleClientSecret) return send(res,503,{error:'Google OAuth aún no está configurado'});
      const trial=trialDetails(url.searchParams);
      if(trial&&!await throttle(db,'trial-registration-start',60))return send(res,429,{error:'Hay muchas solicitudes de registro. Intentá nuevamente en unos minutos.'});
      const organizationSlug = '';
      const inviteToken=url.searchParams.get('invite');
      const invite=inviteToken?await resolveInvite(db,inviteToken):null;
      const state = id();
      await db.query('insert into oauth_states(state,organization_slug,redirect_uri,expires_at) values($1,$2,$3,now()+interval \'10 minutes\')',[state,organizationSlug,googleRedirectUri]);
      if(trial)await db.query('update oauth_states set trial_registration=true where state=$1',[state]);
      if(invite)await db.query('update oauth_states set invite_link_id=$1 where state=$2',[invite.id,state]);
      const params = new URLSearchParams({ client_id: googleClientId, redirect_uri: googleRedirectUri, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
      res.writeHead(302,{Location:`https://accounts.google.com/o/oauth2/v2/auth?${params}`,'Set-Cookie':oauthStateCookie(state,600)}); return res.end();
    }
    if (url.pathname === '/api/auth/google/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state') || ''; const code = url.searchParams.get('code') || '';
      if (!state || parseCookies(req).scale_oauth_state !== state) {res.writeHead(302,{Location:`${appUrl}/?authError=La%20sesión%20de%20Google%20venció.%20Intentá%20nuevamente.`});return res.end();}
      const saved = await db.query('delete from oauth_states where state=$1 and expires_at>now() returning organization_slug,redirect_uri,invite_link_id,trial_registration,client_portal_login,client_portal_invite_id,recent_auth_preview_hash,recent_auth_user_id',[state]);
      if (!saved.rows[0]) return send(res,400,{error:'Sesión de Google inválida o vencida'});
      // Only a consumed, cookie-bound state selects the internal recovery route.
      // Never use callback redirect/next/error_description (or redirect_uri) as a destination.
      const oauthFailure=message=>{
        const target=saved.rows[0].recent_auth_preview_hash?new URL('/configuracion',appUrl):saved.rows[0].client_portal_login?new URL(saved.rows[0].client_portal_invite_id?'invitacion':'ingresar',clientPortalUrl('')):new URL(saved.rows[0].trial_registration?'/registro':saved.rows[0].invite_link_id?'/invitacion':'/',appUrl);
        target.searchParams.set(target.pathname==='/'?'authError':'error',message+(saved.rows[0].invite_link_id?' Volvé a abrir el enlace de invitación e intentá nuevamente.':' Intentá nuevamente desde esta pantalla.'));
        res.writeHead(302,{Location:target.href,'Set-Cookie':oauthStateCookie('',0)});return res.end();
      };
      if(!code||url.searchParams.has('error'))return oauthFailure('No se completó el acceso con Google.');
      let profile;
      try{
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:googleClientId,client_secret:googleClientSecret,redirect_uri:saved.rows[0].redirect_uri,grant_type:'authorization_code'})});
        if (!tokenResponse.ok) return oauthFailure('No se pudo validar el acceso con Google.');
        const tokenData = await tokenResponse.json();
        if(typeof tokenData?.access_token!=='string'||!tokenData.access_token)return oauthFailure('Google no devolvió un acceso válido.');
        const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${tokenData.access_token}`}});
        if (!profileResponse.ok) return oauthFailure('No se pudo obtener el perfil de Google.');
        profile = await profileResponse.json();
        if(!profile||typeof profile!=='object'||Array.isArray(profile))return oauthFailure('Google no devolvió un perfil válido.');
      }catch{return oauthFailure('No se pudo completar la conexión con Google.');}
      const email = String(profile.email || '').trim().toLowerCase();
      if (!email || profile.email_verified !== true) return oauthFailure('Google no confirmó un correo verificado.');
      if(saved.rows[0].recent_auth_preview_hash){
        try{
          const handoff=await issueGoogleRecentAuthHandoff(db,{userId:saved.rows[0].recent_auth_user_id,previewHash:saved.rows[0].recent_auth_preview_hash,profile});
          const target=new URL('/configuracion',appUrl);target.searchParams.set('recentAuthTicket',handoff.ticket);
          res.writeHead(302,{Location:target.href,'Set-Cookie':oauthStateCookie('',0)});return res.end();
        }catch(error){return oauthFailure(error.status?error.message:'No se pudo confirmar tu identidad con Google.');}
      }
      if(saved.rows[0].client_portal_login){
        if(saved.rows[0].client_portal_invite_id){
          try{
            // Un nombre de Google más largo que el límite del portal no puede romper la aceptación.
            const accepted=await acceptClientPortalGoogleInvite({db,inviteId:saved.rows[0].client_portal_invite_id,email,fullName:String(profile.name||email).replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,120)});
            res.writeHead(302,{Location:clientPortalUrl('entregas'),'Set-Cookie':`__Host-scale_client_session=${accepted.rawSession}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`});return res.end();
          }catch(error){return oauthFailure(error.status?error.message:'No se pudo aceptar la invitación del portal.');}
        }
        const portalUser=(await db.query(`select u.id from client_portal_users u where u.email_normalized=$1 and u.disabled_at is null and exists(select 1 from client_portal_grants g join organizations o on o.id=g.organization_id join agency_clients c on c.id=g.client_id and c.organization_id=g.organization_id where g.portal_user_id=u.id and g.active and o.active and c.active)`,[email])).rows[0];
        if(!portalUser){res.writeHead(302,{Location:`${clientPortalUrl('ingresar')}?error=${encodeURIComponent('Este correo todavía no tiene acceso al portal. Aceptá primero la invitación recibida.')}`,'Set-Cookie':oauthStateCookie('',0)});return res.end();}
        const portalToken=id();await db.query("insert into client_portal_sessions(token_hash,portal_user_id,expires_at) values($1,$2,now()+interval '7 days')",[crypto.createHash('sha256').update(portalToken).digest('hex'),portalUser.id]);
        res.writeHead(302,{Location:clientPortalUrl('entregas'),'Set-Cookie':`__Host-scale_client_session=${portalToken}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`});return res.end();
      }
      if(saved.rows[0].trial_registration){
        const ticket=id(),name=typeof profile.name==='string'?profile.name.trim().slice(0,120):'',picture=googleProfilePhoto(profile);
        await db.query("insert into pending_trial_registrations(token_hash,email_normalized,full_name,picture_url,expires_at) values($1,$2,$3,$4,now()+interval '10 minutes')",[crypto.createHash('sha256').update(ticket).digest('hex'),email,name||null,picture]);
        res.writeHead(302,{Location:`${appUrl}/registro?pendingRegistration=${ticket}`,'Set-Cookie':oauthStateCookie('',0)});return res.end();
      }
      if(saved.rows[0].invite_link_id){
        const c=await db.connect();let claim;
        try{await c.query('begin');await c.query("select set_config('app.current_user','google-invitation',true)");claim=await claimInvite(c,saved.rows[0].invite_link_id,profile);await rememberGooglePhoto(c,claim.userId,profile);if(profile.picture||profile.name)await ensurePersonalIdentityInTransaction(c,claim.userId,claim.organizationId);await c.query('commit');}
        catch(e){await c.query('rollback');res.writeHead(302,{Location:`${appUrl}/invitacion?error=${encodeURIComponent(e.status?e.message:'No se pudo aceptar el enlace')}`});return res.end();}finally{c.release();}
        const ticket=id();await db.query("insert into oauth_handoffs(token_hash,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '60 seconds')",[crypto.createHash('sha256').update(ticket).digest('hex'),claim.userId,claim.organizationId]);
        res.writeHead(302,{Location:`${appUrl}/core-api/api/auth/google/complete?ticket=${ticket}`,'Set-Cookie':oauthStateCookie('',0)});return res.end();
      }
      const selected=await loginOrganization(db,{email,orderByName:true});
      const member={rows:selected?[selected]:[]};
      if(!member.rows.length){const pending=await db.query("select u.id,l.organization_id from users u join agency_access_requests r on r.user_id=u.id join agency_invite_links l on l.id=r.link_id join organizations o on o.id=l.organization_id where u.email=$1 and r.status='pending' and o.active=true order by r.created_at desc limit 1",[email]);member.rows=pending.rows;}
      if (!member.rows[0]) { res.writeHead(302,{Location:`${appUrl}/?authError=${encodeURIComponent('Tu correo de Google todavía no fue invitado a esta empresa. Pedí una invitación al administrador.')}`}); return res.end(); }
      if((await db.query('select 1 from account_closure_requests where user_id=$1 and cancelled_at is null and recoverable_until>now()',[member.rows[0].id])).rows.length)return oauthFailure('Esta cuenta tiene un cierre solicitado. Recuperala primero con correo y contraseña.');
      await rememberGooglePhoto(db,member.rows[0].id,profile);
      if(profile.picture||profile.name)await ensurePersonalIdentity(db,member.rows[0].id,member.rows[0].organization_id);
      const ticket=id(); await db.query("insert into oauth_handoffs(token_hash,user_id,organization_id,expires_at,normal_login) values($1,$2,$3,now()+interval '60 seconds',true)",[crypto.createHash('sha256').update(ticket).digest('hex'),member.rows[0].id,member.rows[0].organization_id]);
      res.writeHead(302,{'Location':`${appUrl}/core-api/api/auth/google/complete?ticket=${ticket}`,'Set-Cookie':oauthStateCookie('',0)}); return res.end();
    }
    if(url.pathname==='/api/auth/google/registration/complete'&&req.method==='POST'){
      const input=await body(req),ticket=typeof input.ticket==='string'?input.ticket:'';
      let details;
      try{details=trialDetailsFromInput(input);}catch(error){return send(res,error.status||400,{error:error.message});}
      if(!/^[a-f0-9]{64}$/.test(ticket))return send(res,400,{error:'El registro con Google venció. Volvé a comenzar.'});
      if(!await throttle(db,'trial-registration-complete',60))return send(res,429,{error:'Hay muchas solicitudes de registro. Intentá nuevamente en unos minutos.'});
      const c=await db.connect();
      try{
        await c.query('begin');
        const pending=(await c.query('delete from pending_trial_registrations where token_hash=$1 and expires_at>now() returning email_normalized,full_name,picture_url',[crypto.createHash('sha256').update(ticket).digest('hex')])).rows[0];
        if(!pending)throw Object.assign(Error('El registro con Google venció o ya fue utilizado. Volvé a comenzar.'),{status:400});
        const profile={email:pending.email_normalized,email_verified:true,name:pending.full_name||'',picture:pending.picture_url||undefined};
        const account=await registerTrial(c,profile,details);
        await rememberGooglePhoto(c,account.userId,profile);
        if(profile.picture||profile.name)await ensurePersonalIdentityInTransaction(c,account.userId,account.organizationId);
        const sessionToken=id();
        await c.query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '7 days')",[sessionToken,account.userId,account.organizationId]);
        await c.query('commit');
        const trialEnds=(await db.query('select trial_ends_at from organization_subscriptions where organization_id=$1',[account.organizationId])).rows[0]?.trial_ends_at??null;
        await sendTrialEmail(profile.email,details.name,trialEnds).catch(()=>false);
        return send(res,201,{ok:true,redirect:'/produccion'},{'Set-Cookie':cookie('scale_session',sessionToken,604800)});
      }catch(error){await c.query('rollback');return send(res,error.status||500,{error:error.status?error.message:'No se pudo iniciar la prueba. Intentá nuevamente.'});}
      finally{c.release();}
    }
    if(url.pathname==='/api/auth/google/complete' && req.method==='GET') {
      const ticket=url.searchParams.get('ticket')||'';
      const saved=await db.query('delete from oauth_handoffs where token_hash=$1 and expires_at>now() returning user_id,organization_id,trial_registration,normal_login',[crypto.createHash('sha256').update(ticket).digest('hex')]);
      if(!saved.rows[0]) {res.writeHead(302,{Location:`${appUrl}/?authError=El%20acceso%20venció.%20Intentá%20nuevamente.`});return res.end();}
      if((await db.query('select 1 from account_closure_requests where user_id=$1 and cancelled_at is null and recoverable_until>now()',[saved.rows[0].user_id])).rows.length){res.writeHead(302,{Location:`${appUrl}/recuperar-cuenta`,'Set-Cookie':cookie('scale_session','',0)});return res.end();}
      const preferred=saved.rows[0].normal_login?await loginOrganization(db,{userId:saved.rows[0].user_id,orderByName:true}):null;
      if(preferred)saved.rows[0].organization_id=preferred.organization_id;
      const token=id();await db.query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '7 days')",[token,saved.rows[0].user_id,saved.rows[0].organization_id]);
      const member=await db.query('select 1 from organization_members where user_id=$1 and organization_id=$2 and active=true and removed_at is null',[saved.rows[0].user_id,saved.rows[0].organization_id]);
      res.writeHead(302,{Location:member.rows.length?(saved.rows[0].trial_registration?`${appUrl}/produccion`:preferred?.is_default?`${appUrl}/`:`${appUrl}/?chooseCompany=1`):`${appUrl}/acceso-pendiente`,'Set-Cookie':cookie('scale_session',token,604800)});return res.end();
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') { const t=parseCookies(req).scale_session; if(t) await db.query('delete from sessions where id=$1',[t]); return send(res,200,{ok:true},{'Set-Cookie':cookie('scale_session','',0)}); }
    if(await agencyCore({req,res,url,db,session,body,send,cookie,parseCookies,id,requestSubscription,sendInvitation,sendTrialEmail,auditContext,auditedQuery}))return;
    if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); return res.end(await fs.readFile(path.join(root,'public/index.html'))); }
    send(res,404,{error:'No encontrado'});
  } catch (e) { console.error(JSON.stringify({event:'request_error',requestId,status:e.status||500,code:e.code,method:req.method,path:req.url?.split('?')[0],duration_ms:Date.now()-startedAt})); send(res,e.status||500,{error:e.status?e.message:'Error interno'}); }
});
if (process.env.SCALE_CORE_API_DISABLE_LISTEN !== '1') {
  server.listen(port, () => {
    console.log(`Scale Core API listening on ${port}`);
    init()
      .then(() => { databaseReady = true; startAutomation(db,emailDelivery); server.once('close',startLiveVisitorCleanup(db));server.once('close',startMaintenance(db));console.log(JSON.stringify({event:'email_delivery_readiness',provider:emailDelivery.status.provider,available:emailDelivery.status.available,missing:emailDelivery.status.missing}));console.log('Scale database ready'); })
      .catch((error) => { console.error('Database initialization failed', error); });
  });
}

export { server };
