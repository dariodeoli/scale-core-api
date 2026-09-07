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
const scaleOsOwnerEmail = (process.env.SCALE_OS_OWNER_EMAIL || '').trim().toLowerCase();
const scaleOsOwnerPassword = process.env.SCALE_OS_OWNER_PASSWORD || '';
const allowedOrigin = process.env.PUBLIC_ORIGIN || 'https://scaleparaguay.com';
const allowedOrigins = new Set([allowedOrigin, 'https://scaleparaguay.com', 'https://www.scaleparaguay.com', 'https://admin.scaleparaguay.com', 'https://app.scaleparaguay.com']);
const memberRoles = ['owner','admin','management','finance','sales','production','editor','viewer'];
let databaseReady = false;

const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); };
const cookie = (name, value, maxAge) => `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => { const i=v.indexOf('='); return [v.slice(0,i).trim(), decodeURIComponent(v.slice(i+1))]; }));
const body = async (req) => { let s=''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
const id = () => crypto.randomBytes(32).toString('hex');
async function init() {
  await db.query(await fs.readFile(path.join(root, 'schema.sql'), 'utf8'));
  async function provisionOwner(email, password) {
    if (!email || !password) return;
    const hash = await bcrypt.hash(password, 12);
    const user = await db.query('insert into users(email,password_hash) values($1,$2) on conflict(email) do update set password_hash=excluded.password_hash returning id', [email, hash]);
    await db.query("insert into organization_members(organization_id,user_id,role) select id,$1,'owner' from organizations where slug='scale' on conflict(organization_id,user_id) do nothing", [user.rows[0].id]);
  }
  await provisionOwner(bootstrapEmail, bootstrapPassword);
  await provisionOwner(scaleOsOwnerEmail, scaleOsOwnerPassword);
}
async function session(req) {
  const token = parseCookies(req).scale_session;
  if (!token) return null;
  const r = await db.query('select u.id,u.email,m.role,m.organization_id,o.slug as organization_slug,o.name as organization_name from sessions s join users u on u.id=s.user_id join organization_members m on m.user_id=u.id and m.organization_id=s.organization_id join organizations o on o.id=m.organization_id where s.id=$1 and s.expires_at>now() and o.active=true', [token]);
  return r.rows[0] || null;
}
function can(user, roles) { return Boolean(user && roles.includes(user.role)); }
function security(res, extra={}) { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' data:; img-src 'self' data:; script-src 'self' 'unsafe-inline' data:; connect-src 'self' https://scaleparaguay.com https://www.scaleparaguay.com https://app.scaleparaguay.com"); Object.entries(extra).forEach(([k,v])=>res.setHeader(k,v)); }
function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
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
      const r=await db.query('select u.id,u.password_hash,(select organization_id from organization_members where user_id=u.id order by organization_id limit 1) as organization_id from users u where u.email=$1',[e]);
      if (!r.rows[0] || !(await bcrypt.compare(password,r.rows[0].password_hash))) return send(res,401,{error:'Credenciales inválidas'});
      if (!r.rows[0].organization_id) return send(res,403,{error:'Usuario sin organización asignada'});
      const token=id(); await db.query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '7 days')",[token,r.rows[0].id,r.rows[0].organization_id]);
      return send(res,200,{ok:true},{'Set-Cookie':cookie('scale_session',token,604800)});
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') { const t=parseCookies(req).scale_session; if(t) await db.query('delete from sessions where id=$1',[t]); return send(res,200,{ok:true},{'Set-Cookie':cookie('scale_session','',0)}); }
    if (url.pathname === '/api/auth/me') { const u=await session(req); return u ? send(res,200,{user:u}) : send(res,401,{error:'No autenticado'}); }
    if (url.pathname === '/api/events' && req.method === 'POST') {
      const {name,metadata={}}=await body(req);
      if(!/^[a-z0-9:_-]{1,80}$/i.test(name||'') || !metadata || Array.isArray(metadata) || typeof metadata !== 'object') return send(res,400,{error:'Evento inválido'});
      const scale=await db.query("select id from organizations where slug='scale'");
      await db.query('insert into events(name,metadata,organization_id) values($1,$2,$3)',[name,metadata,scale.rows[0].id]);
      return send(res,202,{ok:true});
    }
    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const from=url.searchParams.get('from') || new Date(Date.now()-366*86400000).toISOString().slice(0,10);
      const to=url.searchParams.get('to') || new Date().toISOString().slice(0,10);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return send(res,400,{error:'Rango inválido'});
      const r=await db.query("select name,event_date::text as event_date,count(*)::int as count from events where organization_id=$1 and event_date between $2 and $3 group by name,event_date order by event_date desc,name",[user.organization_id,from,to]);
      return send(res,200,{events:r.rows});
    }
    if (url.pathname === '/api/agency/clients' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r = await db.query('select * from agency_clients where organization_id=$1 order by active desc,name',[user.organization_id]);
      return send(res,200,{clients:r.rows});
    }
    if (url.pathname === '/api/agency/clients' && req.method === 'POST') {
      const user = await session(req); if (!can(user,['owner','admin','management','sales'])) return send(res,403,{error:'Sin permiso'});
      const {name='',email=null,phone=null,notes=null}=await body(req);
      if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120) return send(res,400,{error:'Nombre inválido'});
      const r=await db.query('insert into agency_clients(name,email,phone,notes,organization_id) values($1,$2,$3,$4,$5) returning *',[name.trim(),email||null,phone||null,notes||null,user.organization_id]);
      return send(res,201,{client:r.rows[0]});
    }
    if (url.pathname === '/api/agency/projects' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r=await db.query("select p.*,c.name as client_name,count(o.id)::int as work_order_count from agency_projects p join agency_clients c on c.id=p.client_id left join agency_work_orders o on o.project_id=p.id where p.organization_id=$1 group by p.id,c.name order by p.created_at desc",[user.organization_id]);
      return send(res,200,{projects:r.rows});
    }
    if (url.pathname === '/api/agency/projects' && req.method === 'POST') {
      const user = await session(req); if (!can(user,['owner','admin','management','sales','production'])) return send(res,403,{error:'Sin permiso'});
      const {name='',clientId,driveUrl=null}=await body(req);
      if (typeof name !== 'string' || name.trim().length < 2 || !Number.isInteger(Number(clientId))) return send(res,400,{error:'Proyecto inválido'});
      const client=await db.query('select id from agency_clients where id=$1 and organization_id=$2',[Number(clientId),user.organization_id]);
      if(!client.rows[0]) return send(res,404,{error:'Cliente no encontrado'});
      const r=await db.query('insert into agency_projects(name,client_id,drive_url,organization_id) values($1,$2,$3,$4) returning *',[name.trim(),Number(clientId),driveUrl||null,user.organization_id]);
      return send(res,201,{project:r.rows[0]});
    }
    if (url.pathname === '/api/agency/work-orders' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r=await db.query('select o.*,p.name as project_name,c.name as client_name,u.email as assignee_email from agency_work_orders o join agency_projects p on p.id=o.project_id join agency_clients c on c.id=p.client_id left join users u on u.id=o.assigned_user_id where o.organization_id=$1 order by o.updated_at desc',[user.organization_id]);
      return send(res,200,{workOrders:r.rows});
    }
    if (url.pathname === '/api/agency/work-orders' && req.method === 'POST') {
      const user = await session(req); if (!can(user,['owner','admin','management','production','editor'])) return send(res,403,{error:'Sin permiso'});
      const {title='',projectId,status='to_record',description=null,driveUrl=null}=await body(req);
      const allowedStatuses=['blocked','to_record','recorded','editing','review','approved','published'];
      if (typeof title !== 'string' || title.trim().length < 2 || !Number.isInteger(Number(projectId)) || !allowedStatuses.includes(status)) return send(res,400,{error:'Orden inválida'});
      const project=await db.query('select id from agency_projects where id=$1 and organization_id=$2',[Number(projectId),user.organization_id]);
      if(!project.rows[0]) return send(res,404,{error:'Proyecto no encontrado'});
      const r=await db.query('insert into agency_work_orders(title,project_id,status,description,drive_url,organization_id) values($1,$2,$3,$4,$5,$6) returning *',[title.trim(),Number(projectId),status,description||null,driveUrl||null,user.organization_id]);
      return send(res,201,{workOrder:r.rows[0]});
    }
    if (url.pathname === '/api/agency/members' && req.method === 'GET') {
      const user = await session(req); if (!can(user,['owner','admin'])) return send(res,403,{error:'Sin permiso'});
      const r = await db.query('select u.id,u.email,m.role,m.created_at from organization_members m join users u on u.id=m.user_id where m.organization_id=$1 order by m.created_at asc',[user.organization_id]);
      return send(res,200,{members:r.rows});
    }
    if (url.pathname === '/api/agency/members' && req.method === 'POST') {
      const user = await session(req); if (!can(user,['owner','admin'])) return send(res,403,{error:'Sin permiso'});
      const {email='',password='',role='viewer'} = await body(req); const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!/^\S+@\S+\.\S+$/.test(normalizedEmail) || typeof password !== 'string' || password.length < 12 || !memberRoles.includes(role) || (role === 'owner' && user.role !== 'owner')) return send(res,400,{error:'Datos de usuario inválidos'});
      const client = await db.connect();
      try {
        await client.query('begin');
        let account = await client.query('select id from users where email=$1',[normalizedEmail]);
        if (!account.rows[0]) {
          const hash = await bcrypt.hash(password,12);
          account = await client.query('insert into users(email,password_hash,role) values($1,$2,$3) returning id',[normalizedEmail,hash,role]);
        }
        const existing = await client.query('select 1 from organization_members where organization_id=$1 and user_id=$2',[user.organization_id,account.rows[0].id]);
        if (existing.rows[0]) { await client.query('rollback'); return send(res,409,{error:'Ese usuario ya pertenece a esta empresa'}); }
        const membership = await client.query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3) returning organization_id,user_id,role,created_at',[user.organization_id,account.rows[0].id,role]);
        await client.query('commit');
        return send(res,201,{member:{id:account.rows[0].id,email:normalizedEmail,...membership.rows[0]}});
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }
    if (url.pathname === '/api/agency/budgets' && req.method === 'GET') {
      const user = await session(req); if (!can(user,['owner','admin','management','finance','sales'])) return send(res,403,{error:'Sin permiso'});
      const r = await db.query("select b.*,c.name as client_name,count(i.id)::int as item_count from agency_budgets b join agency_clients c on c.id=b.client_id left join agency_budget_items i on i.budget_id=b.id where b.organization_id=$1 group by b.id,c.name order by b.created_at desc",[user.organization_id]);
      return send(res,200,{budgets:r.rows});
    }
    if (url.pathname === '/api/agency/budgets' && req.method === 'POST') {
      const user = await session(req); if (!can(user,['owner','admin','management','finance','sales'])) return send(res,403,{error:'Sin permiso'});
      const {title='',clientId,currency='PYG',items=[],notes=null,validUntil=null} = await body(req);
      if (typeof title !== 'string' || title.trim().length < 2 || !Number.isInteger(Number(clientId)) || !['PYG','USD'].includes(currency) || !Array.isArray(items) || !items.length || items.length > 100) return send(res,400,{error:'Presupuesto inválido'});
      const normalizedItems = items.map((item) => ({ description: typeof item?.description === 'string' ? item.description.trim() : '', quantity: Number(item?.quantity), unitPrice: Number(item?.unitPrice) }));
      if (normalizedItems.some(item => item.description.length < 2 || !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unitPrice) || item.unitPrice < 0)) return send(res,400,{error:'Ítems de presupuesto inválidos'});
      const client = await db.connect();
      try {
        await client.query('begin');
        const belongs = await client.query('select id from agency_clients where id=$1 and organization_id=$2',[Number(clientId),user.organization_id]);
        if (!belongs.rows[0]) { await client.query('rollback'); return send(res,404,{error:'Cliente no encontrado'}); }
        const subtotal = normalizedItems.reduce((sum,item) => sum + item.quantity * item.unitPrice, 0);
        const total = subtotal * 1.1;
        const draft = await client.query('insert into agency_budgets(organization_id,client_id,number,title,currency,subtotal,total,notes,valid_until,public_token) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[user.organization_id,Number(clientId),'PENDIENTE',title.trim(),currency,subtotal,total,notes || null,validUntil || null,crypto.randomBytes(18).toString('base64url')]);
        const number = `P-${new Date().getFullYear()}-${String(draft.rows[0].id).padStart(4,'0')}`;
        const budget = await client.query('update agency_budgets set number=$1 where id=$2 returning *',[number,draft.rows[0].id]);
        for (const [position,item] of normalizedItems.entries()) await client.query('insert into agency_budget_items(budget_id,position,description,quantity,unit_price,total) values($1,$2,$3,$4,$5,$6)',[budget.rows[0].id,position + 1,item.description,item.quantity,item.unitPrice,item.quantity * item.unitPrice]);
        await client.query('commit');
        return send(res,201,{budget:budget.rows[0]});
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }
    if (url.pathname === '/api/agency/accounts' && req.method === 'GET') {
      const user=await session(req); if(!can(user,['owner','admin','finance'])) return send(res,403,{error:'Sin permiso'});
      const r=await db.query('select * from bank_accounts where organization_id=$1 order by active desc,name',[user.organization_id]);
      return send(res,200,{accounts:r.rows});
    }
    if (url.pathname === '/api/agency/accounts' && req.method === 'POST') {
      const user=await session(req); if(!can(user,['owner','admin','finance'])) return send(res,403,{error:'Sin permiso'});
      const {name='',accountType='bank',currency='PYG'}=await body(req);
      if(typeof name !== 'string' || name.trim().length<2 || !['bank','cash','digital','investment'].includes(accountType) || !['PYG','USD'].includes(currency)) return send(res,400,{error:'Cuenta inválida'});
      const r=await db.query('insert into bank_accounts(organization_id,name,account_type,currency) values($1,$2,$3,$4) returning *',[user.organization_id,name.trim(),accountType,currency]);
      return send(res,201,{account:r.rows[0]});
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
      const client=await db.query('select id from agency_clients where id=$1 and organization_id=$2',[Number(clientId),user.organization_id]); if(!client.rows[0]) return send(res,404,{error:'Cliente no encontrado'});
      const draft=await db.query('insert into agency_invoices(organization_id,client_id,number,total,currency,due_on,notes) values($1,$2,$3,$4,$5,$6,$7) returning *',[user.organization_id,Number(clientId),'PENDIENTE',amount,currency,dueOn || null,notes || null]);
      const number=`F-${new Date().getFullYear()}-${String(draft.rows[0].id).padStart(4,'0')}`;
      const r=await db.query('update agency_invoices set number=$1 where id=$2 returning *',[number,draft.rows[0].id]);
      return send(res,201,{invoice:r.rows[0]});
    }
    if (url.pathname === '/api/agency/payments' && req.method === 'POST') {
      const user=await session(req); if(!can(user,['owner','admin','finance'])) return send(res,403,{error:'Sin permiso'});
      const {invoiceId,accountId,amount,receivedOn=null,reference=null}=await body(req); const paid=Number(amount);
      if(!Number.isInteger(Number(invoiceId)) || !Number.isInteger(Number(accountId)) || !Number.isFinite(paid) || paid<=0) return send(res,400,{error:'Pago inválido'});
      const valid=await db.query('select i.currency from agency_invoices i join bank_accounts a on a.id=$2 and a.organization_id=i.organization_id and a.currency=i.currency where i.id=$1 and i.organization_id=$3',[Number(invoiceId),Number(accountId),user.organization_id]);
      if(!valid.rows[0]) return send(res,404,{error:'Factura o cuenta no encontrada, o monedas distintas'});
      const r=await db.query('insert into agency_payments(organization_id,invoice_id,account_id,amount,received_on,reference) values($1,$2,$3,$4,$5,$6) returning *',[user.organization_id,Number(invoiceId),Number(accountId),paid,receivedOn || new Date().toISOString().slice(0,10),reference || null]);
      return send(res,201,{payment:r.rows[0]});
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
      const r=await db.query("select (select count(*)::int from agency_clients where organization_id=$1 and active=true) as active_clients, (select count(*)::int from agency_projects where organization_id=$1 and status='active') as active_projects, (select count(*)::int from agency_work_orders where organization_id=$1 and status not in ('approved','published')) as open_orders",[user.organization_id]);
      return send(res,200,{summary:r.rows[0]});
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
