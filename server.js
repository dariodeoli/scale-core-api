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
function security(res, extra={}) { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' data:; img-src 'self' data:; script-src 'self' 'unsafe-inline' data:; connect-src 'self' https://scaleparaguay.com https://www.scaleparaguay.com"); Object.entries(extra).forEach(([k,v])=>res.setHeader(k,v)); }
const server = http.createServer(async (req,res) => {
  security(res, { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type' });
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
    if (url.pathname === '/api/events' && req.method === 'POST') { const {name,metadata={}}=await body(req); if(!/^[a-z0-9:_-]{1,80}$/i.test(name||'')) return send(res,400,{error:'Evento inválido'}); await db.query('insert into events(name,metadata) values($1,$2)',[name,metadata]); return send(res,202,{ok:true}); }
    if (url.pathname === '/api/metrics' && req.method === 'GET') { if(!(await session(req))) return send(res,401,{error:'No autenticado'}); const r=await db.query("select name,event_date,count(*)::int as count from events group by name,event_date order by event_date desc"); return send(res,200,{events:r.rows}); }
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
