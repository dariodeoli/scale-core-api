// Explicitly generated, expired fixtures only. Never deletes users or audit history.
import {createHash} from 'node:crypto';
const templateSlug = 'scale-demo-controles-20260908';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const scopedTables = `organizations organization_members sessions events oauth_handoffs
 agency_clients agency_projects agency_work_orders agency_budgets agency_budget_items
 bank_accounts agency_invoices agency_payments account_transfers agency_collaborators
 agency_commissions agency_project_comments agency_payouts agency_payment_reversals
 agency_statement_lines agency_reconciliation_matches agency_content_reviews agency_referral_discounts
 agency_archived_records agency_plans agency_leads agency_inventory agency_exchange_rates agency_settings
 agency_user_profiles agency_order_comments agency_internal_tasks agency_source_events agency_work_templates
 agency_template_runs agency_demo_sessions agency_notification_preferences agency_notifications
 agency_recurring_plans agency_presence_tabs agency_usage_sessions agency_job_roles agency_job_catalogs
 agency_invite_links agency_access_requests oauth_states
 agency_project_assignees agency_work_order_assignees agency_inventory_categories
 agency_inventory_reservations agency_inventory_reservation_members agency_inventory_reservation_items
 agency_work_checklists agency_work_checklist_items`.trim().split(/\s+/);
const switches = [
 ['agency_payments', 'agency_payments_sync'],
 ['agency_payment_reversals', 'payment_reversal_sync'],
 ['account_transfers', 'account_transfers_sync'],
];
const ident = value => '"' + value.replaceAll('"', '""') + '"';
const tableName = table => 'public.' + ident(table);
const failure = code => Object.assign(new Error(code), {maintenanceCode: code});
function integer(value, fallback, min, max, name) {
 const n = value === undefined ? fallback : Number(value);
 if (!Number.isSafeInteger(n) || n < min || n > max) throw failure('INVALID_' + name);
 return n;
}
export function maintenanceSettings(env = process.env) {
 return {
  graceHours: integer(env.DEMO_CLEANUP_GRACE_HOURS, 24, 24, 8760, 'GRACE_HOURS'),
  maxDemos: integer(env.DEMO_CLEANUP_BATCH_SIZE, 3, 1, 20, 'DEMO_BATCH'),
  maxDemoRows: integer(env.DEMO_CLEANUP_MAX_ROWS, 10000, 1, 50000, 'DEMO_ROWS'),
  presenceDays: integer(env.PRESENCE_RETENTION_DAYS, 30, 1, 3650, 'PRESENCE_DAYS'),
  usageDays: integer(env.USAGE_RETENTION_DAYS, 90, 30, 3650, 'USAGE_DAYS'),
  retentionBatch: integer(env.PRESENCE_CLEANUP_BATCH_SIZE, 1000, 1, 10000, 'RETENTION_BATCH'),
  intervalMs: integer(env.MAINTENANCE_INTERVAL_MS, 3600000, 60000, 86400000, 'INTERVAL'),
  runTimeoutMs: integer(env.MAINTENANCE_TIMEOUT_MS, 30000, 1000, 60000, 'TIMEOUT'),
 };
}
// Two distinct creation paths exist: private sessions and public anonymous demos.
const eligible = `o.id<>22 and o.slug ~ $2 and o.demo_owner_user_id is not null
 and o.demo_expires_at is not null and isfinite(o.demo_expires_at)
 and o.demo_expires_at>o.created_at
 and o.demo_expires_at<now()-$1::int*interval '1 hour'
 and exists(select 1 from organization_members m where m.organization_id=o.id and m.user_id=o.demo_owner_user_id)
 and (
  (o.demo_source_id is not null and exists(select 1 from organizations src
    where src.id=o.demo_source_id and src.slug='${templateSlug}' and src.demo_owner_user_id is null)
   and exists(select 1 from agency_demo_sessions d where d.organization_id=o.id
    and d.user_id=o.demo_owner_user_id and length(d.demo_key)>0))
  or (o.demo_source_id is null and exists(select 1 from users u where u.id=o.demo_owner_user_id
    and u.is_demo_guest=true and u.password_hash='!public-demo-no-login'
    and u.email='visitante-'||substring(o.slug from 14)||'@demo.example.invalid'))
 )
 and not exists(select 1 from organization_members m join users u on u.id=m.user_id
  where m.organization_id=o.id and m.user_id<>o.demo_owner_user_id
  and not (u.password_hash='!fictional-demo-no-login'
   and u.email ~ ('^persona-'||o.id||'-[0-9]+@demo[.]example[.]invalid$')))
 and not exists(select 1 from sessions s where s.organization_id=o.id and s.expires_at>now())
 and not exists(select 1 from agency_presence_tabs p where p.organization_id=o.id and p.last_seen_at>now()-interval '75 seconds')`;
const scope = (table, alias) => {
 if (table === 'organizations') return `${alias}.id=$1`;
 if (table === 'agency_budget_items') return `${alias}.budget_id in (select id from public.agency_budgets where organization_id=$1)`;
 if (table === 'agency_access_requests') return `${alias}.link_id in (select id from public.agency_invite_links where organization_id=$1)`;
 if (table === 'oauth_states') return `${alias}.invite_link_id in (select id from public.agency_invite_links where organization_id=$1)`;
 return `${alias}.organization_id=$1`;
};
async function deletionPlan(c, org, maxRows) {
 const tables = (await c.query(`select tablename from pg_tables where schemaname='public' and tablename=any($1::text[])`, [scopedTables])).rows.map(r => r.tablename);
 const known = new Set(tables);
 const edges = (await c.query(`select cn.nspname as child_schema,cl.relname as child,
  pn.nspname as parent_schema,pl.relname as parent,
  array(select a.attname from unnest(f.conkey) with ordinality k(n,pos)
   join pg_attribute a on a.attrelid=f.conrelid and a.attnum=k.n order by k.pos) as child_cols,
  array(select a.attname from unnest(f.confkey) with ordinality k(n,pos)
   join pg_attribute a on a.attrelid=f.confrelid and a.attnum=k.n order by k.pos) as parent_cols
  from pg_constraint f join pg_class cl on cl.oid=f.conrelid join pg_namespace cn on cn.oid=cl.relnamespace
  join pg_class pl on pl.oid=f.confrelid join pg_namespace pn on pn.oid=pl.relnamespace
  where f.contype='f' and pn.nspname='public' and pl.relname=any($1::text[])`, [tables])).rows;
 // Stop concurrent changes/cascades during preflight and trigger suspension. Locks
 // are transactional, deterministic and limited by lock_timeout + the run deadline.
 const locks = new Set(tables.map(tableName));
 for (const e of edges) locks.add(ident(e.child_schema) + '.' + ident(e.child));
 await c.query(`lock table ${[...locks].sort().join(',')} in share row exclusive mode`);
 let total = 0;
 const counts = {};
 for (const t of tables) {
  counts[t] = (await c.query(`select count(*)::int as n from (select 1 from ${tableName(t)} t where ${scope(t, 't')} limit $2) bounded`, [org, maxRows + 1])).rows[0].n;
  total += counts[t];
  if (total > maxRows) throw failure('DEMO_ROW_LIMIT');
 }
 // A cross-tenant CASCADE/SET NULL is just as dangerous as a direct delete.
 // Unknown tables (including WEEM/Dadoo/snapshots) are never silently cascaded.
 for (const e of edges) {
  const childKnown = e.child_schema === 'public' && known.has(e.child);
  const join = e.child_cols.map((col, i) => `ch.${ident(col)}=pa.${ident(e.parent_cols[i])}`).join(' and ');
  const unsafe = childKnown ? `and (${scope(e.child, 'ch')}) is not true` : '';
  const found = (await c.query(`select 1 from ${ident(e.child_schema)}.${ident(e.child)} ch
   join ${tableName(e.parent)} pa on ${join} where ${scope(e.parent, 'pa')} ${unsafe} limit 1`, [org])).rows.length;
  if (found) throw failure(childKnown ? 'CROSS_TENANT_REFERENCE' : 'UNOWNED_REFERENCE');
 }
 const pending = new Set(tables), order = [];
 while (pending.size) {
  const leaf = [...pending].find(t => !edges.some(e => e.parent === t && e.child_schema === 'public'
   && pending.has(e.child) && e.child !== e.parent));
  if (!leaf) throw failure('CYCLIC_SCHEMA');
  order.push(leaf); pending.delete(leaf);
 }
 return {order, counts, total};
}
async function purgeDemo(c, org, settings, dryRun) {
 const plan = await deletionPlan(c, org, settings.maxDemoRows);
 const stillEligible = (await c.query(`select o.id from organizations o where ${eligible} and o.id=$3`,
  [settings.graceHours, '^demo-session-' + uuid + '$', org])).rows.length;
 if (!stillEligible) throw failure('DEMO_CHANGED');
 for (const [table, trigger] of switches) {
  const state = (await c.query(`select tgenabled from pg_trigger where tgrelid=$1::regclass and tgname=$2 and not tgisinternal`, [tableName(table), trigger])).rows[0];
  if (state?.tgenabled !== 'O') throw failure('FINANCIAL_GUARD_NOT_ENABLED');
 }
 if (dryRun) return {organizationId: org, rows: plan.total, status: 'eligible'};
 for (const [table, trigger] of switches) await c.query(`alter table ${tableName(table)} disable trigger ${ident(trigger)}`);
 for (const t of plan.order) {
  const deleted = await c.query(`delete from ${tableName(t)} t where ${scope(t, 't')}`, [org]);
  if (deleted.rowCount !== plan.counts[t]) throw failure('UNEXPECTED_DELETE_COUNT');
 }
 for (const [table, trigger] of switches) await c.query(`alter table ${tableName(table)} enable trigger ${ident(trigger)}`);
 await c.query(`insert into agency_operation_audit(organization_id,table_name,action,actor,ip,before_state,after_state)
  values($1,'organizations','DELETE','system:expired-demo-cleanup','maintenance-worker',$2::jsonb,null)`,
 [org, JSON.stringify({generatedDemo: true, counts: plan.counts})]);
 return {organizationId: org, rows: plan.total, status: 'deleted'};
}
async function retain(c, table, days, limit, dryRun) {
 const selected = `select ctid from ${tableName(table)} where last_seen_at<now()-$1::int*interval '1 day'
  order by last_seen_at limit $2 for update skip locked`;
 if (dryRun) return (await c.query(`select count(*)::int as n from (${selected}) stale`, [days, limit])).rows[0].n;
 return (await c.query(`delete from ${tableName(table)} where ctid in (${selected})`, [days, limit])).rowCount;
}
function verifyDeletionEvidence(evidence, env) {
 let source;
 try { const u = new URL(env.DATABASE_URL); source = createHash('sha256').update(u.hostname + ':' + (u.port || '5432') + '/' + decodeURIComponent(u.pathname.slice(1))).digest('hex'); } catch { throw failure('VERIFIED_BACKUP_REQUIRED'); }
 const age = Date.now() - Date.parse(evidence?.verifiedAt);
 const backupAge = Date.now() - Date.parse(evidence?.backupCreatedAt);
 if (evidence?.event !== 'r2_restore_verified' || evidence.externalBackupVerified !== true
  || !/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(evidence.backupId || '') || evidence.sourceDatabaseHash !== source
  || !Number.isFinite(age) || age < 0 || age > 86400000
  || !Number.isFinite(backupAge) || backupAge < 0 || backupAge > 86400000) throw failure('VERIFIED_BACKUP_REQUIRED');
}
export async function runMaintenance(db, {dryRun = true, demoDryRun = true, verifiedBackup = null, env = process.env} = {}) {
 if (typeof dryRun !== 'boolean' || typeof demoDryRun !== 'boolean') throw failure('INVALID_DRY_RUN');
 if (!dryRun && !demoDryRun) verifyDeletionEvidence(verifiedBackup, env);
 const settings = maintenanceSettings(env), started = Date.now();
 const raw = await db.connect();
 const c = {query: async (sql, values) => {
  const remaining = settings.runTimeoutMs - (Date.now() - started);
  if (remaining <= 0) throw failure('RUN_DEADLINE');
  await raw.query("select set_config('statement_timeout',$1,true)", [String(Math.min(5000, remaining))]);
  return raw.query(sql, values);
 }};
 try {
  await raw.query('begin');
  await c.query("set local lock_timeout='1s'");
  await c.query("set local idle_in_transaction_session_timeout='10s'");
  await c.query("set local search_path=public,pg_catalog");
  const locked = (await c.query(`select pg_try_advisory_xact_lock(hashtextextended('scale-maintenance',0)) as locked`)).rows[0].locked;
  const schemaLocked = locked && (await c.query(`select pg_try_advisory_xact_lock(hashtextextended('scale-core-schema',0)) as locked`)).rows[0].locked;
  if (!schemaLocked) { await raw.query('rollback'); return {dryRun, demoDryRun: dryRun || demoDryRun, skipped: 'busy'}; }
  await c.query("select set_config('app.current_user','system:expired-demo-cleanup',true),set_config('app.current_ip','maintenance-worker',true)");
  const args = [settings.graceHours, '^demo-session-' + uuid + '$'];
  const candidates = (await c.query(`select o.id from organizations o where ${eligible}
   order by o.demo_expires_at,o.id limit $3 for update of o skip locked`, [...args, settings.maxDemos])).rows;
  const demos = [];
  for (const {id} of candidates) {
   await c.query('savepoint demo_cleanup');
   try {
    // Recheck under locks; extending expiration must never race deletion.
    const valid = (await c.query(`select o.id from organizations o where ${eligible} and o.id=$3`, [...args, id])).rows.length;
    if (valid) demos.push(await purgeDemo(c, id, settings, dryRun || demoDryRun));
    await c.query('release savepoint demo_cleanup');
   } catch (error) {
    await raw.query('rollback to savepoint demo_cleanup');
    if (error.maintenanceCode === 'RUN_DEADLINE') throw error;
    demos.push({organizationId: id, status: 'blocked', reason: error.maintenanceCode || 'DATABASE_GUARD'});
   }
  }
  const presenceTabs = await retain(c, 'agency_presence_tabs', settings.presenceDays, settings.retentionBatch, dryRun);
  const usageSessions = await retain(c, 'agency_usage_sessions', settings.usageDays, settings.retentionBatch, dryRun);
  await raw.query(dryRun ? 'rollback' : 'commit');
  return {dryRun, demoDryRun: dryRun || demoDryRun, demos, presenceTabs, usageSessions, usersDeleted: 0, auditPreserved: true};
 } catch (error) { await raw.query('rollback'); throw error; }
 finally { raw.release(); }
}
const workers = new WeakMap();
export function startMaintenance(db, {env = process.env, log = console.log, timers = globalThis} = {}) {
 if (workers.has(db)) return workers.get(db);
 if (!['true', 'false', undefined].includes(env.MAINTENANCE_ENABLED)) throw failure('INVALID_ENABLED');
 if (env.MAINTENANCE_ENABLED !== 'true') return () => {};
 const settings = maintenanceSettings(env);
 let running = false, stopped = false;
 const tick = async () => {
  if (running || stopped) return;
  running = true;
  // Demo deletion stays disabled in the scheduled entrypoint pending a verified
  // external backup and a separate, explicitly reviewed integration.
  try { log(JSON.stringify({event: 'maintenance_complete', ...await runMaintenance(db, {dryRun: false, demoDryRun: true, env})})); }
  catch { log(JSON.stringify({event: 'maintenance_failed'})); }
  finally { running = false; }
 };
 const timer = timers.setInterval(() => { void tick(); }, settings.intervalMs);
 timer.unref?.();
 const stop = () => { stopped = true; timers.clearInterval(timer); workers.delete(db); };
 workers.set(db, stop);
 void tick();
 return stop;
}
