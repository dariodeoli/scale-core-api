import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Pool } = pg;
const port = Number(process.env.PORT || 3000);
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
const root = path.dirname(fileURLToPath(import.meta.url));
const bootstrapEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const bootstrapPassword = process.env.ADMIN_PASSWORD || '';
const allowedOrigin = process.env.PUBLIC_ORIGIN || 'https://scaleparaguay.com';
const allowedOrigins = new Set([allowedOrigin, 'https://scaleparaguay.com', 'https://www.scaleparaguay.com', 'https://admin.scaleparaguay.com', 'https://app.scaleparaguay.com']);
let databaseReady = false;

const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); };
const cookie = (name, value, maxAge) => `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => { const i=v.indexOf('='); return [v.slice(0,i).trim(), decodeURIComponent(v.slice(i+1))]; }));
const body = async (req) => { let s=''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
const id = () => crypto.randomBytes(32).toString('hex');
async function init() {
  await db.query(await fs.readFile(path.join(root, 'schema.sql'), 'utf8'));
  if (bootstrapEmail && bootstrapPassword) {
    const hash = await bcrypt.hash(bootstrapPassword, 12);
    await db.query('insert into users(email,password_hash) values($1,$2) on conflict(email) do update set password_hash=excluded.password_hash', [bootstrapEmail, hash]);
  }
}
async function session(req) {
  const token = parseCookies(req).scale_session;
  if (!token) return null;
  const r = await db.query('select u.id,u.email,u.role from sessions s join users u on u.id=s.user_id where s.id=$1 and s.expires_at>now()', [token]);
  return r.rows[0] || null;
}
function can(user, roles) { return Boolean(user && roles.includes(user.role)); }
function security(res, extra={}) { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' data:; img-src 'self' data:; script-src 'self' 'unsafe-inline' data:; connect-src 'self' https://scaleparaguay.com https://www.scaleparaguay.com"); Object.entries(extra).forEach(([k,v])=>res.setHeader(k,v)); }
function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
  return true;
}
const server = http.createServer(async (req,res) => {
  security(res);
  if (!cors(req, res)) return send(res,403,{error:'Origen no permitido'});
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/health') return send(res,databaseReady ? 200 : 503,{ok:databaseReady,database:databaseReady ? 'ready' : 'initializing'});
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const { email='', password='' } = await body(req); const e=email.trim().toLowerCase();
      const r=await db.query('select id,password_hash from users where email=$1',[e]);
      if (!r.rows[0] || !(await bcrypt.compare(password,r.rows[0].password_hash))) return send(res,401,{error:'Credenciales inválidas'});
      const token=id(); await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '7 days')",[token,r.rows[0].id]);
      return send(res,200,{ok:true},{'Set-Cookie':cookie('scale_session',token,604800)});
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') { const t=parseCookies(req).scale_session; if(t) await db.query('delete from sessions where id=$1',[t]); return send(res,200,{ok:true},{'Set-Cookie':cookie('scale_session','',0)}); }
    if (url.pathname === '/api/auth/me') { const u=await session(req); return u ? send(res,200,{user:u}) : send(res,401,{error:'No autenticado'}); }
    if (url.pathname === '/api/events' && req.method === 'POST') {
      const {name,metadata={}}=await body(req);
      if(!/^[a-z0-9:_-]{1,80}$/i.test(name||'') || !metadata || Array.isArray(metadata) || typeof metadata !== 'object') return send(res,400,{error:'Evento inválido'});
      await db.query('insert into events(name,metadata) values($1,$2)',[name,metadata]);
      return send(res,202,{ok:true});
    }
    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      if(!(await session(req))) return send(res,401,{error:'No autenticado'});
      const from=url.searchParams.get('from') || new Date(Date.now()-366*86400000).toISOString().slice(0,10);
      const to=url.searchParams.get('to') || new Date().toISOString().slice(0,10);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return send(res,400,{error:'Rango inválido'});
      const r=await db.query("select name,event_date::text as event_date,count(*)::int as count from events where event_date between $1 and $2 group by name,event_date order by event_date desc,name",[from,to]);
      return send(res,200,{events:r.rows});
    }
    if (url.pathname === '/api/agency/clients' && req.method === 'GET') {
      if (!(await session(req))) return send(res,401,{error:'No autenticado'});
      const r = await db.query('select * from agency_clients order by active desc,name');
      return send(res,200,{clients:r.rows});
    }
    if (url.pathname === '/api/agency/clients' && req.method === 'POST') {
      const user = await session(req); if (!can(user,['owner','admin','management','sales'])) return send(res,403,{error:'Sin permiso'});
      const {name='',email=null,phone=null,notes=null}=await body(req);
      if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120) return send(res,400,{error:'Nombre inválido'});
      const r=await db.query('insert into agency_clients(name,email,phone,notes) values($1,$2,$3,$4) returning *',[name.trim(),email||null,phone||null,notes||null]);
      return send(res,201,{client:r.rows[0]});
    }
    if (url.pathname === '/api/agency/projects' && req.method === 'GET') {
      if (!(await session(req))) return send(res,401,{error:'No autenticado'});
      const r=await db.query("select p.*,c.name as client_name,count(o.id)::int as work_order_count from agency_projects p join agency_clients c on c.id=p.client_id left join agency_work_orders o on o.project_id=p.id group by p.id,c.name order by p.created_at desc");
      return send(res,200,{projects:r.rows});
    }
    if (url.pathname === '/api/agency/projects' && req.method === 'POST') {
      const user = await session(req); if (!can(user,['owner','admin','management','sales','production'])) return send(res,403,{error:'Sin permiso'});
      const {name='',clientId,driveUrl=null}=await body(req);
      if (typeof name !== 'string' || name.trim().length < 2 || !Number.isInteger(Number(clientId))) return send(res,400,{error:'Proyecto inválido'});
      const r=await db.query('insert into agency_projects(name,client_id,drive_url) values($1,$2,$3) returning *',[name.trim(),Number(clientId),driveUrl||null]);
      return send(res,201,{project:r.rows[0]});
    }
    if (url.pathname === '/api/agency/work-orders' && req.method === 'GET') {
      if (!(await session(req))) return send(res,401,{error:'No autenticado'});
      const r=await db.query('select o.*,p.name as project_name,c.name as client_name,u.email as assignee_email from agency_work_orders o join agency_projects p on p.id=o.project_id join agency_clients c on c.id=p.client_id left join users u on u.id=o.assigned_user_id order by o.updated_at desc');
      return send(res,200,{workOrders:r.rows});
    }
    if (url.pathname === '/api/agency/work-orders' && req.method === 'POST') {
      const user = await session(req); if (!can(user,['owner','admin','management','production','editor'])) return send(res,403,{error:'Sin permiso'});
      const {title='',projectId,status='to_record',description=null,driveUrl=null}=await body(req);
      const allowedStatuses=['blocked','to_record','recorded','editing','review','approved','published'];
      if (typeof title !== 'string' || title.trim().length < 2 || !Number.isInteger(Number(projectId)) || !allowedStatuses.includes(status)) return send(res,400,{error:'Orden inválida'});
      const r=await db.query('insert into agency_work_orders(title,project_id,status,description,drive_url) values($1,$2,$3,$4,$5) returning *',[title.trim(),Number(projectId),status,description||null,driveUrl||null]);
      return send(res,201,{workOrder:r.rows[0]});
    }
    if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); return res.end(await fs.readFile(path.join(root,'public/index.html'))); }
    send(res,404,{error:'No encontrado'});
  } catch (e) { console.error(e); send(res,500,{error:'Error interno'}); }
});
server.listen(port, () => {
  console.log(`Scale Core API listening on ${port}`);
  init()
    .then(() => { databaseReady = true; console.log('Scale database ready'); })
    .catch((error) => { console.error('Database initialization failed', error); });
});
