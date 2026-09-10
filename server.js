import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { operations } from './operations.js';
import { suite } from './agency-suite.js';
import { passwordAccess, throttle } from './password-access.js';
import { financeControls } from './finance-controls.js';
import { contentReview } from './content-review.js';
import { budgetSections } from './budget-sections.js';
import { externalLink } from './media-policy.js';
import {clientColor,clientLogo} from './client-identity.js';
import { recordLifecycle, visibleRecord } from './record-lifecycle.js';
import { invitationEmail } from './invitation-email.js';
import { productivity } from './productivity.js';

const { Pool } = pg;
const port = Number(process.env.PORT || 3000);
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
const root = path.dirname(fileURLToPath(import.meta.url));
const bootstrapEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const bootstrapPassword = process.env.ADMIN_PASSWORD || '';
const scaleOsOwnerEmail = (process.env.SCALE_OS_OWNER_EMAIL || '').trim().toLowerCase();
const scaleOsOwnerPassword = process.env.SCALE_OS_OWNER_PASSWORD || '';
const dadooOwnerEmail = (process.env.DADOO_OWNER_EMAIL || '').trim().toLowerCase();
const dadooOwnerPassword = process.env.DADOO_OWNER_PASSWORD || '';
const googleClientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const googleRedirectUri = (process.env.GOOGLE_REDIRECT_URI || 'https://admin.scaleparaguay.com/api/auth/google/callback').trim();
const appUrl = (process.env.APP_URL || 'https://app.scaleparaguay.com').replace(/\/$/, '');
const resendApiKey = process.env.RESEND_API_KEY || '';
const invitationFrom = process.env.EMAIL_FROM || 'Scale OS <invitaciones@owncoding.dev>';
const allowedOrigin = process.env.PUBLIC_ORIGIN || 'https://scaleparaguay.com';
const allowedOrigins = new Set([allowedOrigin, 'https://scaleparaguay.com', 'https://www.scaleparaguay.com', 'https://admin.scaleparaguay.com', 'https://app.scaleparaguay.com', 'https://dadoocapital.com', 'https://www.dadoocapital.com', 'https://admin.dadoocapital.com']);
const memberRoles = ['owner','admin','management','finance','sales','production','editor','viewer'];
let databaseReady = false;

const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); };
const cookie = (name, value, maxAge) => `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => { const i=v.indexOf('='); return [v.slice(0,i).trim(), decodeURIComponent(v.slice(i+1))]; }));
const body = async (req) => { let s=''; for await (const c of req) {s += c;if(s.length>1048576)throw Object.assign(new Error('Solicitud demasiado grande'),{status:413});} return s ? JSON.parse(s) : {}; };
const id = () => crypto.randomBytes(32).toString('hex');
async function sendInvitation(email, organizationName, role) {
  if (!resendApiKey) return false;
  const response = await fetch('https://api.resend.com/emails', { method:'POST', signal:AbortSignal.timeout(10000), headers:{Authorization:`Bearer ${resendApiKey}`,'Content-Type':'application/json'}, body:JSON.stringify({from:invitationFrom,to:[email],...invitationEmail({email,organizationName,role,appUrl})}) });
  return response.ok;
}
async function sendReset(email,token){if(!resendApiKey)return false;const response=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${resendApiKey}`,'Content-Type':'application/json'},body:JSON.stringify({from:invitationFrom,to:[email],subject:'Establecé tu contraseña de Scale OS',html:`<main style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px"><h1>Tu contraseña</h1><p>Este enlace es de un solo uso y vence en una hora. Si no lo solicitaste, ignorá este correo.</p><a href="${appUrl}/?resetToken=${token}">Establecer contraseña</a></main>`})});return response.ok;}
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
    await migration.query('commit');
  }catch(error){await migration.query('rollback');throw error;}finally{migration.release();}
  async function provisionOwner(email, password) {
    if (!email || !password) return;
    const hash = await bcrypt.hash(password, 12);
    const user = await db.query('insert into users(email,password_hash) values($1,$2) on conflict(email) do update set email=excluded.email returning id', [email, hash]);
    await db.query("insert into organization_members(organization_id,user_id,role) select id,$1,'owner' from organizations where slug='scale' on conflict(organization_id,user_id) do nothing", [user.rows[0].id]);
  }
  await provisionOwner(bootstrapEmail, bootstrapPassword);
  await provisionOwner(scaleOsOwnerEmail, scaleOsOwnerPassword);
  await provisionOwnerForOrganization(dadooOwnerEmail, dadooOwnerPassword, 'dadoo-capital');
}
async function provisionOwnerForOrganization(email, password, slug) {
  if (!email || !password) return;
  const hash = await bcrypt.hash(password, 12);
  const user = await db.query('insert into users(email,password_hash) values($1,$2) on conflict(email) do update set password_hash=excluded.password_hash returning id', [email, hash]);
  await db.query("insert into organization_members(organization_id,user_id,role) select id,$1,'owner' from organizations where slug=$2 on conflict(organization_id,user_id) do update set role='owner'", [user.rows[0].id, slug]);
}
async function session(req) {
  const token = parseCookies(req).scale_session;
  if (!token) return null;
  const r = await db.query('select u.id,u.email,up.full_name,up.photo_url,m.role,m.organization_id,o.slug as organization_slug,o.name as organization_name from sessions s join users u on u.id=s.user_id join organization_members m on m.user_id=u.id and m.organization_id=s.organization_id join organizations o on o.id=m.organization_id left join agency_user_profiles up on up.user_id=u.id and up.organization_id=m.organization_id where s.id=$1 and s.expires_at>now() and o.active=true and m.active=true', [token]);
  return r.rows[0] || null;
}
function can(user, roles) { return Boolean(user && roles.includes(user.role)); }
async function auditContext(client,user,req){await client.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);}
async function auditedQuery(user,req,sql,params){const c=await db.connect();try{await c.query('begin');await auditContext(c,user,req);const r=await c.query(sql,params);await c.query('commit');return r;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
function security(res, extra={}) { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' data:; img-src 'self' data:; script-src 'self' 'unsafe-inline' data:; connect-src 'self' https://scaleparaguay.com https://www.scaleparaguay.com https://app.scaleparaguay.com"); Object.entries(extra).forEach(([k,v])=>res.setHeader(k,v)); }
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
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if(await recordLifecycle({req,res,url,db,session,send}))return;
    if(await passwordAccess({req,res,url,db,body,send,sendReset}))return;
    if(await financeControls({req,res,url,db,session,body,send}))return;
    if(await contentReview({req,res,url,db,session,body,send}))return;
    if(await productivity({req,res,url,db,session,body,send}))return;
    if(await suite({req,res,url,db,session,body,send,sendInvitation}))return;
    if (await operations({req,res,url,db,session,body,send,sendInvitation})) return;
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(302, { Location: 'https://app.scaleparaguay.com' });
      return res.end();
    }
    if (url.pathname === '/health') return send(res,databaseReady ? 200 : 503,{ok:databaseReady,database:databaseReady ? 'ready' : 'initializing'});
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const { email='', password='' } = await body(req); const e=email.trim().toLowerCase();
      if(!await throttle(db,'login:'+e,30))return send(res,429,{error:'Demasiados intentos. Esperá 15 minutos.'});
      const r=await db.query('select u.id,u.password_hash,(select organization_id from organization_members where user_id=u.id and active=true order by organization_id limit 1) as organization_id from users u where u.email=$1',[e]);
      if (!r.rows[0] || !(await bcrypt.compare(password,r.rows[0].password_hash))) return send(res,401,{error:'Credenciales inválidas'});
      if (!r.rows[0].organization_id) return send(res,403,{error:'Usuario sin organización asignada'});
      const token=id(); await db.query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '7 days')",[token,r.rows[0].id,r.rows[0].organization_id]);
      return send(res,200,{ok:true},{'Set-Cookie':cookie('scale_session',token,604800)});
    }
    if (url.pathname === '/api/auth/providers' && req.method === 'GET') {
      return send(res,200,{google:Boolean(googleClientId && googleClientSecret)});
    }
    if (url.pathname === '/api/auth/google/start' && req.method === 'GET') {
      if (!googleClientId || !googleClientSecret) return send(res,503,{error:'Google OAuth aún no está configurado'});
      const organizationSlug = '';
      const state = id();
      await db.query('insert into oauth_states(state,organization_slug,redirect_uri,expires_at) values($1,$2,$3,now()+interval \'10 minutes\')',[state,organizationSlug,googleRedirectUri]);
      const params = new URLSearchParams({ client_id: googleClientId, redirect_uri: googleRedirectUri, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
      res.writeHead(302,{Location:`https://accounts.google.com/o/oauth2/v2/auth?${params}`,'Set-Cookie':cookie('scale_oauth_state',state,600)}); return res.end();
    }
    if (url.pathname === '/api/auth/google/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state') || ''; const code = url.searchParams.get('code') || '';
      if (!state || parseCookies(req).scale_oauth_state !== state) {res.writeHead(302,{Location:`${appUrl}/?authError=La%20sesión%20de%20Google%20venció.%20Intentá%20nuevamente.`});return res.end();}
      const saved = await db.query('delete from oauth_states where state=$1 and expires_at>now() returning organization_slug,redirect_uri',[state]);
      if (!saved.rows[0] || !code) return send(res,400,{error:'Sesión de Google inválida o vencida'});
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:googleClientId,client_secret:googleClientSecret,redirect_uri:saved.rows[0].redirect_uri,grant_type:'authorization_code'})});
      if (!tokenResponse.ok) return send(res,401,{error:'No se pudo validar Google'});
      const tokenData = await tokenResponse.json();
      const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${tokenData.access_token}`}});
      if (!profileResponse.ok) return send(res,401,{error:'No se pudo obtener el perfil de Google'});
      const profile = await profileResponse.json(); const email = String(profile.email || '').trim().toLowerCase();
      if (!email || profile.email_verified !== true) return send(res,403,{error:'La cuenta de Google no está verificada'});
      const member = await db.query('select u.id,m.organization_id from users u join organization_members m on m.user_id=u.id join organizations o on o.id=m.organization_id where u.email=$1 and o.active=true and m.active=true order by o.name',[email]);
      if (!member.rows[0]) { res.writeHead(302,{Location:`${appUrl}/?authError=${encodeURIComponent('Tu correo de Google todavía no fue invitado a esta empresa. Pedí una invitación al administrador.')}`}); return res.end(); }
      const ticket=id(); await db.query("insert into oauth_handoffs(token_hash,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '60 seconds')",[crypto.createHash('sha256').update(ticket).digest('hex'),member.rows[0].id,member.rows[0].organization_id]);
      res.writeHead(302,{'Location':`${appUrl}/core-api/api/auth/google/complete?ticket=${ticket}`,'Set-Cookie':cookie('scale_oauth_state','',0)}); return res.end();
    }
    if(url.pathname==='/api/auth/google/complete' && req.method==='GET') {
      const ticket=url.searchParams.get('ticket')||'';
      const saved=await db.query('delete from oauth_handoffs where token_hash=$1 and expires_at>now() returning user_id,organization_id',[crypto.createHash('sha256').update(ticket).digest('hex')]);
      if(!saved.rows[0]) {res.writeHead(302,{Location:`${appUrl}/?authError=El%20acceso%20venció.%20Intentá%20nuevamente.`});return res.end();}
      const token=id();await db.query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '7 days')",[token,saved.rows[0].user_id,saved.rows[0].organization_id]);
      res.writeHead(302,{Location:`${appUrl}/?chooseCompany=1`,'Set-Cookie':cookie('scale_session',token,604800)});return res.end();
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') { const t=parseCookies(req).scale_session; if(t) await db.query('delete from sessions where id=$1',[t]); return send(res,200,{ok:true},{'Set-Cookie':cookie('scale_session','',0)}); }
    if (url.pathname === '/api/auth/me') { const u=await session(req); return u ? send(res,200,{user:u}) : send(res,401,{error:'No autenticado'}); }
    if (url.pathname === '/api/auth/organizations' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r=await db.query('select o.id,o.slug,o.name,m.role from organization_members m join organizations o on o.id=m.organization_id where m.user_id=$1 and o.active=true and m.active=true order by o.name',[user.id]);
      return send(res,200,{organizations:r.rows,currentOrganizationId:user.organization_id});
    }
    if(url.pathname==='/api/auth/organizations'&&req.method==='POST'){
      const user=await session(req);if(!can(user,['owner','admin']))return send(res,403,{error:'Solo administración puede crear una empresa'});
      const b=await body(req),name=typeof b.name==='string'?b.name.trim():'',slug=typeof b.slug==='string'?b.slug.trim().toLowerCase():'';
      if(name.length<2||name.length>160||!/^\w[\w-]{2,59}$/.test(slug))return send(res,400,{error:'Nombre y código de empresa inválidos'});
      const c=await db.connect();try{await c.query('begin');const org=(await c.query('insert into organizations(name,slug) values($1,$2) returning *',[name,slug])).rows[0];await c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org.id,user.id]);await c.query('commit');return send(res,201,{organization:org});}catch(e){await c.query('rollback');return send(res,e.code==='23505'?409:500,{error:e.code==='23505'?'Ese código ya está utilizado':'No se pudo crear la empresa'});}finally{c.release();}
    }
    if (url.pathname === '/api/auth/switch-organization' && req.method === 'POST') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'}); const {organizationId}=await body(req);
      const membership=await db.query('select 1 from organization_members m join organizations o on o.id=m.organization_id where m.user_id=$1 and m.organization_id=$2 and o.active=true and m.active=true',[user.id,Number(organizationId)]);
      if(!membership.rows[0]) return send(res,403,{error:'No pertenecés a esa empresa'});
      const token=id(); await db.query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '7 days')",[token,user.id,Number(organizationId)]);
      return send(res,200,{ok:true},{'Set-Cookie':cookie('scale_session',token,604800)});
    }
    if (url.pathname === '/api/events' && req.method === 'POST') {
      const {name,metadata={}}=await body(req);
      if(!/^[a-z0-9:_-]{1,80}$/i.test(name||'') || !metadata || Array.isArray(metadata) || typeof metadata !== 'object') return send(res,400,{error:'Evento inválido'});
      const scale=await db.query("select id from organizations where slug='scale'");
      await db.query('insert into events(name,metadata,organization_id) values($1,$2,$3)',[name,metadata,scale.rows[0].id]);
      return send(res,202,{ok:true});
    }
    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      if(!can(user,['owner','admin'])) return send(res,403,{error:'Sin permiso'});
      const from=url.searchParams.get('from') || new Date(Date.now()-366*86400000).toISOString().slice(0,10);
      const to=url.searchParams.get('to') || new Date().toISOString().slice(0,10);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return send(res,400,{error:'Rango inválido'});
      const r=await db.query("select name,event_date::text as event_date,count(*)::int as count from events where organization_id=$1 and event_date between $2 and $3 group by name,event_date order by event_date desc,name",[user.organization_id,from,to]);
      return send(res,200,{events:r.rows});
    }
    if (url.pathname === '/api/hub/organizations' && req.method === 'GET') {
      const user=await session(req); if(!can(user,['owner','admin'])) return send(res,403,{error:'Sin permiso'});
      const r=await db.query('select o.slug,o.name,o.active,m.role from organizations o join organization_members m on m.organization_id=o.id where m.user_id=$1 and m.active=true and m.removed_at is null order by o.name',[user.id]);
      return send(res,200,{organizations:r.rows});
    }
    if (url.pathname === '/api/hub/overview' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r=await db.query(`select o.slug,o.name,
        coalesce(sum(case when v.metric_key='revenue' then v.value else 0 end),0)::numeric as revenue,
        coalesce(sum(case when v.metric_key='collected' then v.value else 0 end),0)::numeric as collected,
        coalesce(sum(case when v.metric_key='leads' then v.value else 0 end),0)::numeric as leads,
        coalesce(sum(case when v.metric_key='sales' then v.value else 0 end),0)::numeric as sales
        from organizations o join organization_members m on m.organization_id=o.id
        left join hub_metric_values v on v.organization_id=o.id and v.period_end >= current_date - interval '30 days'
        where m.user_id=$1 and m.active=true and m.removed_at is null and o.active=true group by o.id order by o.name`,[user.id]);
      return send(res,200,{organizations:r.rows});
    }
    if (url.pathname === '/api/hub/metrics' && req.method === 'POST') {
      const integrationKey = process.env.HUB_INGEST_KEY;
      if (!integrationKey || req.headers['x-hub-integration-key'] !== integrationKey) return send(res,401,{error:'Clave de integración inválida'});
      const {organizationSlug, integrationSlug=null, metrics=[]}=await body(req);
      if(typeof organizationSlug !== 'string' || !Array.isArray(metrics) || !metrics.length || metrics.length > 100) return send(res,400,{error:'Payload de métricas inválido'});
      const org=await db.query('select id from organizations where slug=$1 and active=true',[organizationSlug]);
      if(!org.rows[0]) return send(res,404,{error:'Organización no encontrada'});
      const integration=integrationSlug ? await db.query('select id from hub_integrations where organization_id=$1 and slug=$2 and active=true',[org.rows[0].id,integrationSlug]) : {rows:[]};
      const client=await db.connect();
      try { await client.query('begin'); for(const metric of metrics) { if(typeof metric?.key !== 'string' || !Number.isFinite(Number(metric.value))) throw new Error('Métrica inválida'); await client.query('insert into hub_metric_values(organization_id,integration_id,metric_key,value,currency,period_start,period_end,metadata) values($1,$2,$3,$4,$5,$6,$7,$8)',[org.rows[0].id,integration.rows[0]?.id || null,metric.key,Number(metric.value),metric.currency || null,metric.periodStart || null,metric.periodEnd || null,metric.metadata || {}]); } await client.query('commit'); return send(res,202,{ok:true,accepted:metrics.length}); }
      catch(error) { await client.query('rollback'); return send(res,400,{error:error instanceof Error ? error.message : 'No se pudieron guardar las métricas'}); }
      finally { client.release(); }
    }
    if (url.pathname === '/api/agency/client-payment-status' && req.method === 'GET') {
      const user=await session(req); if(!can(user,['owner','admin','management','finance','sales'])) return send(res,403,{error:'Sin permiso'});
      const status=url.searchParams.get('status');
      const statuses=['up_to_date','due_soon','late','severe'];
      if(status && !statuses.includes(status)) return send(res,400,{error:'Estado de cobro inválido'});
      const r=await db.query(`select * from client_payment_status where organization_id=$1 ${status ? 'and payment_status=$2' : ''} order by days_overdue desc, next_due_on nulls last, client_name`,status?[user.organization_id,status]:[user.organization_id]);
      return send(res,200,{clients:r.rows});
    }
    if (url.pathname === '/api/agency/clients' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r = await db.query(`select c.* from agency_clients c where organization_id=$1 and ${visibleRecord('c','clients')} order by active desc,name`,[user.organization_id]);
      return send(res,200,{clients:r.rows});
    }
    if (url.pathname === '/api/agency/clients' && req.method === 'POST') {
      const user = await session(req); if (!can(user,['owner','admin','management','sales'])) return send(res,403,{error:'Sin permiso'});
      const {name='',email=null,phone=null,notes=null,logo_url=null,color_key='violet'}=await body(req);
      if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120) return send(res,400,{error:'Nombre inválido'});
      const logo=await clientLogo(logo_url),color=clientColor(color_key);
      const r=await auditedQuery(user,req,'insert into agency_clients(name,email,phone,notes,organization_id,logo_url,color_key) values($1,$2,$3,$4,$5,$6,$7) returning *',[name.trim(),email||null,phone||null,notes||null,user.organization_id,logo,color]);
      return send(res,201,{client:r.rows[0]});
    }
    if (url.pathname === '/api/agency/projects' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r=await db.query(`select p.*,c.name as client_name,count(o.id)::int as work_order_count from agency_projects p join agency_clients c on c.id=p.client_id left join agency_work_orders o on o.project_id=p.id and ${visibleRecord('o','work-orders')} where p.organization_id=$1 and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')} group by p.id,c.name order by p.created_at desc`,[user.organization_id]);
      return send(res,200,{projects:r.rows});
    }
    if (url.pathname === '/api/agency/projects' && req.method === 'POST') {
      const user = await session(req); if (!can(user,['owner','admin','management','sales','production'])) return send(res,403,{error:'Sin permiso'});
      const {name='',clientId,driveUrl:rawDriveUrl=null}=await body(req);
      const driveUrl=externalLink(rawDriveUrl);
      if (typeof name !== 'string' || name.trim().length < 2 || !Number.isInteger(Number(clientId))) return send(res,400,{error:'Proyecto inválido'});
      const client=await db.query(`select id from agency_clients c where id=$1 and organization_id=$2 and ${visibleRecord('c','clients')}`,[Number(clientId),user.organization_id]);
      if(!client.rows[0]) return send(res,404,{error:'Cliente no encontrado'});
      const r=await auditedQuery(user,req,'insert into agency_projects(name,client_id,drive_url,organization_id) values($1,$2,$3,$4) returning *',[name.trim(),Number(clientId),driveUrl||null,user.organization_id]);
      return send(res,201,{project:r.rows[0]});
    }
    if (url.pathname === '/api/agency/work-orders' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r=await db.query(`select o.*,p.name as project_name,c.name as client_name,u.email as assignee_email from agency_work_orders o join agency_projects p on p.id=o.project_id join agency_clients c on c.id=p.client_id left join users u on u.id=o.assigned_user_id where o.organization_id=$1 and ${visibleRecord('o','work-orders')} and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')} order by o.updated_at desc`,[user.organization_id]);
      return send(res,200,{workOrders:r.rows});
    }
    if (url.pathname === '/api/agency/work-orders' && req.method === 'POST') {
      const user = await session(req); if (!can(user,['owner','admin','management','production','editor'])) return send(res,403,{error:'Sin permiso'});
      const {title='',projectId,status='to_record',description=null,driveUrl:rawDriveUrl=null}=await body(req);
      const driveUrl=externalLink(rawDriveUrl);
      const allowedStatuses=['blocked','to_record','recorded','editing','review'];
      if (typeof title !== 'string' || title.trim().length < 2 || !Number.isInteger(Number(projectId)) || !allowedStatuses.includes(status)) return send(res,400,{error:'Orden inválida'});
      const project=await db.query(`select p.id from agency_projects p join agency_clients c on c.id=p.client_id where p.id=$1 and p.organization_id=$2 and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')}`,[Number(projectId),user.organization_id]);
      if(!project.rows[0]) return send(res,404,{error:'Proyecto no encontrado'});
      const r=await auditedQuery(user,req,'insert into agency_work_orders(title,project_id,status,description,drive_url,organization_id) values($1,$2,$3,$4,$5,$6) returning *',[title.trim(),Number(projectId),status,description||null,driveUrl||null,user.organization_id]);
      return send(res,201,{workOrder:r.rows[0]});
    }
    if (url.pathname === '/api/agency/members' && req.method === 'GET') {
      const user = await session(req); if (!can(user,['owner','admin'])) return send(res,403,{error:'Sin permiso'});
      const r = await db.query('select u.id,u.email,m.role,m.active,m.created_at from organization_members m join users u on u.id=m.user_id where m.organization_id=$1 and m.removed_at is null order by m.created_at asc',[user.organization_id]);
      return send(res,200,{members:r.rows});
    }
    if (url.pathname === '/api/agency/members' && req.method === 'POST') {
      const user = await session(req); if (!can(user,['owner','admin'])) return send(res,403,{error:'Sin permiso'});
      const {email='',password='',role='viewer'} = await body(req); const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!/^\S+@\S+\.\S+$/.test(normalizedEmail) || (password && (typeof password !== 'string' || password.length < 12)) || !memberRoles.includes(role) || (role === 'owner' && user.role !== 'owner')) return send(res,400,{error:'Datos de invitación inválidos'});
      const client = await db.connect();
      try {
        await client.query('begin');
        await auditContext(client,user,req);
        let account = await client.query('select id from users where email=$1',[normalizedEmail]);
        if (!account.rows[0]) {
          const hash = await bcrypt.hash(password || id(),12);
          account = await client.query('insert into users(email,password_hash,role) values($1,$2,$3) returning id',[normalizedEmail,hash,role]);
        }
        await client.query('select id from organizations where id=$1 for update',[user.organization_id]);
        const existing = await client.query('select removed_at from organization_members where organization_id=$1 and user_id=$2 for update',[user.organization_id,account.rows[0].id]);
        if (existing.rows[0]&&!existing.rows[0].removed_at) { await client.query('rollback'); return send(res,409,{error:'Ese usuario ya pertenece a esta empresa'}); }
        const membership = await client.query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3) on conflict(organization_id,user_id) do update set role=excluded.role,active=true,removed_at=null,created_at=now() returning organization_id,user_id,role,created_at',[user.organization_id,account.rows[0].id,role]);
        await client.query('commit');
        const member={id:account.rows[0].id,email:normalizedEmail,...membership.rows[0]};
        const emailSent=await sendInvitation(normalizedEmail,user.organization_name,role).catch(()=>false);
        return send(res,201,{member,emailSent});
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }
    if (url.pathname === '/api/agency/budgets' && req.method === 'GET') {
      const user = await session(req); if (!can(user,['owner','admin','management','finance','sales'])) return send(res,403,{error:'Sin permiso'});
      const r = await db.query(`select b.*,c.name as client_name,count(i.id)::int as item_count from agency_budgets b join agency_clients c on c.id=b.client_id left join agency_budget_items i on i.budget_id=b.id where b.organization_id=$1 and ${visibleRecord('b','budgets')} group by b.id,c.name order by b.created_at desc`,[user.organization_id]);
      return send(res,200,{budgets:r.rows});
    }
    if (url.pathname === '/api/agency/budgets' && req.method === 'POST') {
      const user = await session(req); if (!can(user,['owner','admin','management','finance','sales'])) return send(res,403,{error:'Sin permiso'});
      const {title='',clientId,currency='PYG',items=[],notes=null,validUntil=null,tax_rate=.1,sections=null} = await body(req);
      const normalizedSections=budgetSections(sections);
      if(![0,.05,.1].includes(Number(tax_rate)))return send(res,400,{error:'IVA inválido'});
      if (typeof title !== 'string' || title.trim().length < 2 || !Number.isInteger(Number(clientId)) || !['PYG','USD'].includes(currency) || !Array.isArray(items) || !items.length || items.length > 100) return send(res,400,{error:'Presupuesto inválido'});
      const normalizedItems = items.map((item) => ({ description: typeof item?.description === 'string' ? item.description.trim() : '', quantity: Number(item?.quantity), unitPrice: Number(item?.unitPrice) }));
      if (normalizedItems.some(item => item.description.length < 2 || !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unitPrice) || item.unitPrice < 0)) return send(res,400,{error:'Ítems de presupuesto inválidos'});
      const client = await db.connect();
      try {
        await client.query('begin');
        const belongs = await client.query(`select id from agency_clients c where id=$1 and organization_id=$2 and ${visibleRecord('c','clients')}`,[Number(clientId),user.organization_id]);
        await auditContext(client,user,req);
        if (!belongs.rows[0]) { await client.query('rollback'); return send(res,404,{error:'Cliente no encontrado'}); }
        const subtotal = normalizedItems.reduce((sum,item) => sum + item.quantity * item.unitPrice, 0);
        const total = Math.round(subtotal * (1+Number(tax_rate))*100)/100;
        const draft = await client.query('insert into agency_budgets(organization_id,client_id,number,title,currency,subtotal,total,notes,valid_until,public_token) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[user.organization_id,Number(clientId),'PENDIENTE',title.trim(),currency,subtotal,total,notes || null,validUntil || null,crypto.randomBytes(18).toString('base64url')]);
        const number = `P-${new Date().getFullYear()}-${String(draft.rows[0].id).padStart(4,'0')}`;
        await client.query('update agency_budgets set tax_rate=$1,sections=$3 where id=$2',[Number(tax_rate),draft.rows[0].id,JSON.stringify(normalizedSections)]);
        const budget = await client.query('update agency_budgets set number=$1 where id=$2 returning *',[number,draft.rows[0].id]);
        for (const [position,item] of normalizedItems.entries()) await client.query('insert into agency_budget_items(budget_id,position,description,quantity,unit_price,total) values($1,$2,$3,$4,$5,$6)',[budget.rows[0].id,position + 1,item.description,item.quantity,item.unitPrice,item.quantity * item.unitPrice]);
        await client.query('commit');
        return send(res,201,{budget:budget.rows[0]});
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }
    if (url.pathname === '/api/agency/accounts' && req.method === 'GET') {
      const user=await session(req); if(!can(user,['owner','admin','finance'])) return send(res,403,{error:'Sin permiso'});
      const r=await db.query(`select a.*,u.email as custodian_email from bank_accounts a left join users u on u.id=a.custodian_user_id where a.organization_id=$1 and ${visibleRecord('a','accounts')} order by a.active desc,a.name`,[user.organization_id]);
      return send(res,200,{accounts:r.rows});
    }
    if (url.pathname === '/api/agency/accounts' && req.method === 'POST') {
      const user=await session(req); if(!can(user,['owner','admin','finance'])) return send(res,403,{error:'Sin permiso'});
      const {name='',accountType='bank',currency='PYG',institution=null,accountNumber=null,holderName=null,custodianUserId=null}=await body(req);
      if(typeof name !== 'string' || name.trim().length<2 || !['bank','cash','digital','investment'].includes(accountType) || !['PYG','USD'].includes(currency)) return send(res,400,{error:'Cuenta inválida'});
      const custodianId=custodianUserId === null || custodianUserId === '' ? null : Number(custodianUserId);
      if(custodianId !== null && (!Number.isInteger(custodianId) || !(await db.query('select 1 from organization_members where organization_id=$1 and user_id=$2',[user.organization_id,custodianId])).rows[0])) return send(res,400,{error:'Custodio inválido'});
      const r=await auditedQuery(user,req,'insert into bank_accounts(organization_id,name,account_type,currency,institution,account_number,holder_name,custodian_user_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[user.organization_id,name.trim(),accountType,currency,typeof institution === 'string' ? institution.trim() || null : null,typeof accountNumber === 'string' ? accountNumber.trim() || null : null,typeof holderName === 'string' ? holderName.trim() || null : null,custodianId]);
      return send(res,201,{account:r.rows[0]});
    }
    if (url.pathname === '/api/agency/custodians' && req.method === 'GET') {
      const user=await session(req); if(!can(user,['owner','admin','management','finance','production','editor','sales'])) return send(res,403,{error:'Sin permiso'});
      const r=await db.query('select u.id,u.email,m.role from organization_members m join users u on u.id=m.user_id where m.organization_id=$1 and m.active=true order by u.email',[user.organization_id]);
      return send(res,200,{members:r.rows});
    }
    if (url.pathname === '/api/agency/invoices' && req.method === 'GET') {
      const user=await session(req); if(!can(user,['owner','admin','finance','management','sales'])) return send(res,403,{error:'Sin permiso'});
      const r=await db.query('select i.*,c.name as client_name from agency_invoices i join agency_clients c on c.id=i.client_id where i.organization_id=$1 order by i.created_at desc',[user.organization_id]);
      return send(res,200,{invoices:r.rows});
    }
    if (url.pathname === '/api/agency/invoices' && req.method === 'POST') {
      const user=await session(req); if(!can(user,['owner','admin','finance','management','sales'])) return send(res,403,{error:'Sin permiso'});
      const {clientId,total,currency='PYG',dueOn=null,notes=null}=await body(req); const amount=Number(total);
      if(!Number.isInteger(Number(clientId)) || !Number.isFinite(amount) || amount<0 || !['PYG','USD'].includes(currency)) return send(res,400,{error:'Factura inválida'});
      const client=await db.query(`select id from agency_clients c where id=$1 and organization_id=$2 and ${visibleRecord('c','clients')}`,[Number(clientId),user.organization_id]); if(!client.rows[0]) return send(res,404,{error:'Cliente no encontrado'});
      const number=`F-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const r=await auditedQuery(user,req,'insert into agency_invoices(organization_id,client_id,number,total,currency,due_on,notes) values($1,$2,$3,$4,$5,$6,$7) returning *',[user.organization_id,Number(clientId),number,amount,currency,dueOn || null,notes || null]);
      return send(res,201,{invoice:r.rows[0]});
    }
    if (url.pathname === '/api/agency/payments' && req.method === 'GET') {
      const user=await session(req); if(!can(user,['owner','admin','finance','management','sales'])) return send(res,403,{error:'Sin permiso'});
      const r=await db.query('select p.*,i.number as invoice_number,c.name as client_name,a.name as account_name,a.account_type,a.currency,u.email as received_by_email from agency_payments p join agency_invoices i on i.id=p.invoice_id join agency_clients c on c.id=i.client_id join bank_accounts a on a.id=p.account_id left join users u on u.id=p.received_by_user_id where p.organization_id=$1 order by p.received_on desc,p.id desc',[user.organization_id]);
      return send(res,200,{payments:r.rows});
    }
    if (url.pathname === '/api/agency/payments' && req.method === 'POST') {
      const user=await session(req); if(!can(user,['owner','admin','finance'])) return send(res,403,{error:'Sin permiso'});
      const {invoiceId,accountId,amount,receivedOn=null,reference=null,receivedByUserId=null}=await body(req); const paid=Number(amount);
      if(!Number.isInteger(Number(invoiceId)) || !Number.isInteger(Number(accountId)) || !Number.isFinite(paid) || paid<=0) return send(res,400,{error:'Pago inválido'});
      const valid=await db.query('select i.currency,i.total,i.paid_amount from agency_invoices i join bank_accounts a on a.id=$2 and a.organization_id=i.organization_id and a.currency=i.currency where i.id=$1 and i.organization_id=$3',[Number(invoiceId),Number(accountId),user.organization_id]);
      if(!valid.rows[0]) return send(res,404,{error:'Factura o cuenta no encontrada, o monedas distintas'});
      if(paid > Number(valid.rows[0].total) - Number(valid.rows[0].paid_amount)) return send(res,400,{error:'El cobro supera el saldo pendiente'});
      const receiver=receivedByUserId === null || receivedByUserId === '' ? Number(user.id) : Number(receivedByUserId);
      if(!Number.isInteger(receiver) || !(await db.query('select 1 from organization_members where organization_id=$1 and user_id=$2',[user.organization_id,receiver])).rows[0]) return send(res,400,{error:'Persona que recibió el pago inválida'});
      const r=await db.query('insert into agency_payments(organization_id,invoice_id,account_id,amount,received_on,reference,received_by_user_id) values($1,$2,$3,$4,$5,$6,$7) returning *',[user.organization_id,Number(invoiceId),Number(accountId),paid,receivedOn || new Date().toISOString().slice(0,10),reference || null,receiver]);
      return send(res,201,{payment:r.rows[0]});
    }
    if (url.pathname === '/api/agency/transfers' && req.method === 'GET') {
      const user=await session(req); if(!can(user,['owner','admin','finance'])) return send(res,403,{error:'Sin permiso'});
      const r=await db.query('select t.*,f.name as from_account_name,d.name as to_account_name,u.email as created_by_email from account_transfers t join bank_accounts f on f.id=t.from_account_id join bank_accounts d on d.id=t.to_account_id left join users u on u.id=t.created_by_user_id where t.organization_id=$1 order by t.transferred_on desc,t.id desc',[user.organization_id]);
      return send(res,200,{transfers:r.rows});
    }
    if (url.pathname === '/api/agency/transfers' && req.method === 'POST') {
      const user=await session(req); if(!can(user,['owner','admin','finance'])) return send(res,403,{error:'Sin permiso'});
      const {fromAccountId,toAccountId,amount,transferredOn=null,reference=null,notes=null}=await body(req); const transferAmount=Number(amount);
      if(!Number.isInteger(Number(fromAccountId)) || !Number.isInteger(Number(toAccountId)) || Number(fromAccountId)===Number(toAccountId) || !Number.isFinite(transferAmount) || transferAmount<=0) return send(res,400,{error:'Transferencia inválida'});
      const accounts=await db.query('select id,currency,balance from bank_accounts where organization_id=$1 and id=any($2::bigint[])',[user.organization_id,[Number(fromAccountId),Number(toAccountId)]]);
      if(accounts.rows.length!==2 || accounts.rows[0].currency!==accounts.rows[1].currency) return send(res,400,{error:'Las cuentas deben existir y usar la misma moneda'});
      const source=accounts.rows.find(account=>Number(account.id)===Number(fromAccountId));
      if(Number(source.balance)<transferAmount) return send(res,400,{error:'Saldo insuficiente en la cuenta de origen'});
      const r=await db.query('insert into account_transfers(organization_id,from_account_id,to_account_id,amount,transferred_on,reference,notes,created_by_user_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[user.organization_id,Number(fromAccountId),Number(toAccountId),transferAmount,transferredOn || new Date().toISOString().slice(0,10),typeof reference === 'string' ? reference.trim() || null : null,typeof notes === 'string' ? notes.trim() || null : null,user.id]);
      return send(res,201,{transfer:r.rows[0]});
    }
    const orderMatch = url.pathname.match(/^\/api\/agency\/work-orders\/(\d+)$/);
    if (orderMatch && req.method === 'PATCH') {
      const user = await session(req); if (!can(user,['owner','admin','management','production','editor'])) return send(res,403,{error:'Sin permiso'});
      const { status } = await body(req);
      const allowedStatuses=['blocked','to_record','recorded','editing','review','approved','published'];
      if (!allowedStatuses.includes(status)) return send(res,400,{error:'Estado inválido'});
      const r=await db.query('update agency_work_orders set status=$1,updated_at=now() where id=$2 and organization_id=$3 returning *',[status,Number(orderMatch[1]),user.organization_id]);
      if (!r.rows[0]) return send(res,404,{error:'Orden no encontrada'});
      return send(res,200,{workOrder:r.rows[0]});
    }
    if (url.pathname === '/api/agency/summary' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r=await db.query(`select (select count(*)::int from agency_clients c where organization_id=$1 and active=true and ${visibleRecord('c','clients')}) as active_clients, (select count(*)::int from agency_projects p join agency_clients c on c.id=p.client_id where p.organization_id=$1 and p.status='active' and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')}) as active_projects, (select count(*)::int from agency_work_orders o join agency_projects p on p.id=o.project_id join agency_clients c on c.id=p.client_id where o.organization_id=$1 and o.status not in ('approved','published') and ${visibleRecord('o','work-orders')} and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')}) as open_orders`,[user.organization_id]);
      return send(res,200,{summary:r.rows[0]});
    }
    if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); return res.end(await fs.readFile(path.join(root,'public/index.html'))); }
    send(res,404,{error:'No encontrado'});
  } catch (e) { console.error(JSON.stringify({event:'request_error',status:e.status||500,code:e.code})); send(res,e.status||500,{error:e.status?e.message:'Error interno'}); }
});
server.listen(port, () => {
  console.log(`Scale Core API listening on ${port}`);
  init()
    .then(() => { databaseReady = true; console.log('Scale database ready'); })
    .catch((error) => { console.error('Database initialization failed', error); });
});
