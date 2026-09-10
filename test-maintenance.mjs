import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID, createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {demoOrganization, seedPrivateDemo} from './demo-session.js';
import {runMaintenance as maintenance, maintenanceSettings, startMaintenance} from './maintenance.js';

// Synthetic receipt is exclusively a unit-test fixture; no external backup was verified.
const fixtureDatabase = 'postgres://fixture:fixture@fixture.invalid/fixture';
const fixtureEvidence = {event: 'r2_restore_verified', externalBackupVerified: true,
 backupId: '20260910T120000Z-' + randomUUID(), verifiedAt: new Date().toISOString(), backupCreatedAt: new Date().toISOString(),
 sourceDatabaseHash: createHash('sha256').update('fixture.invalid:5432/fixture').digest('hex')};
const runMaintenance = (db, options = {}) => maintenance(db, {...options, demoDryRun: false,
 verifiedBackup: fixtureEvidence, env: {DATABASE_URL: fixtureDatabase, ...options.env}});

const pg = new PGlite();
await pg.exec(await fs.readFile('schema.sql', 'utf8'));
for (const name of ['20260908_client_payment_status', '20260908_treasury_ledger', '20260908_google_oauth',
 '20260908_people_commissions_comments', '20260908_operations_complete', '20260908_referral_discounts',
 '20260908_collaborator_profiles', '20260908_agency_suite', '20260908_daily_controls',
 '20260910_productivity', '20260910_profile_identity', '20260910_demo_sessions', '20260910_notifications',
 '20260910_client_links', '20260910_client_lifecycle', '20260910_ruc_lookup', '20260910_presence',
 '20260910_invite_links', '20260910_currencies', '20260910_global_identity', '20260910_project_assignees',
 '20260910_live_visitors', '20260910_company_currency', '20260910_inventory_reservations',
 '20260910_work_checklists']) await pg.exec(await fs.readFile(`migrations/${name}.sql`, 'utf8'));
const query = (s, v) => pg.query(s, v), c = {query};
const db = {connect: async () => ({query, release() {}})};
const insert = async (s, v) => (await query(s + ' returning id', v)).rows[0].id;
const count = async (table, org) => (await query(`select count(*)::int as n from ${table}${org ? ' where organization_id=$1' : ''}`, org ? [org] : [])).rows[0].n;
const owner = await insert("insert into users(email,password_hash) values('maintenance-owner@example.invalid','canonical')");
// The seed builds a new organization's catalog. Do not run it over Scale's
// pre-existing migration catalog; this protected real-company fixture is fresh.
const real = await insert("insert into organizations(slug,name) values('maintenance-real-fixture','Protected real fixture')");
const template = await insert("insert into organizations(slug,name) values('scale-demo-controles-20260908','Template')");
await query("insert into organization_members(organization_id,user_id,role) values($1,$3,'owner'),($2,$3,'owner')", [real, template, owner]);
await query("insert into organizations(id,slug,name) values(22,'protected-other','Protected 22')");
await query("insert into sessions(id,user_id,organization_id,expires_at) values('real-session',$1,$2,now()+interval '7 days')", [owner, real]);
const expired = async org => query("update organizations set created_at=now()-interval '20 days',demo_expires_at=now()-interval '2 days' where id=$1", [org]);
async function fixture(full = false) {
 if (full) {
  await query('begin');
  const org = await demoOrganization(c, {userId: owner, sourceId: template, demoKey: randomUUID()});
  await query('commit'); await expired(org); return org;
 }
 const org = await insert("insert into organizations(slug,name,demo_owner_user_id,demo_source_id) values($1,'Fixture',$2,$3)", ['demo-session-' + randomUUID(), owner, template]);
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')", [org, owner]);
 await query('insert into agency_demo_sessions(demo_key,user_id,organization_id) values($1,$2,$3)', [randomUUID(), owner, org]);
 await expired(org); return org;
}
// Real financial data is synthetic test-only, but must remain byte-for-byte intact.
await seedPrivateDemo(c, real, owner);
await query("select set_config('app.current_user',$1,false),set_config('app.current_organization',$2,false)", [String(owner), String(real)]);
await query("insert into user_personal_identities(user_id,full_name) values($1,'Canonical identity')", [owner]);
const identitiesBefore = (await query('select * from user_personal_identities order by user_id')).rows;
const protectedTables = ['organizations','users','organization_members','sessions','bank_accounts','agency_invoices','agency_payments','account_transfers','agency_inventory_categories','agency_inventory','agency_inventory_reservations','agency_work_checklists','agency_work_checklist_items'];
const capture = async () => Object.fromEntries(await Promise.all(protectedTables.filter(t => t !== 'users').map(async t =>
 [t, (await query(`select * from ${t} where ${t === 'organizations' ? 'id' : 'organization_id'} in ($1,$2,22) order by 1`, [real, template])).rows])));
const baseline = await capture();
const full = await fixture(true);
const fixtureProject = (await query('select id from agency_projects where organization_id=$1 order by id limit 1', [full])).rows[0].id;
const fixtureOrder = (await query('select id from agency_work_orders where organization_id=$1 order by id limit 1', [full])).rows[0].id;
const fixtureInventory = (await query('select id from agency_inventory where organization_id=$1 order by id limit 1', [full])).rows[0].id;
await query('insert into agency_project_assignees(organization_id,project_id,user_id) values($1,$2,$3)', [full, fixtureProject, owner]);
await query('insert into agency_work_order_assignees(organization_id,work_order_id,user_id) values($1,$2,$3)', [full, fixtureOrder, owner]);
// Reuse the checklist supplied by the demo; add a fixture-specific extra item.
await query('insert into agency_work_checklists(organization_id,work_order_id) values($1,$2) on conflict do nothing', [full, fixtureOrder]);
await query("insert into agency_work_checklist_items(organization_id,work_order_id,text,created_by_user_id) values($1,$2,'Demo checklist',$3)", [full, fixtureOrder, owner]);
const reservation = await insert("insert into agency_inventory_reservations(organization_id,project_id,title,starts_at,ends_at,created_by_user_id,return_user_id) values($1,$2,'Demo reservation',now(),now()+interval '1 hour',$3,$3)", [full, fixtureProject, owner]);
await query('insert into agency_inventory_reservation_members(organization_id,reservation_id,user_id) values($1,$2,$3)', [full, reservation, owner]);
await query('insert into agency_inventory_reservation_items(organization_id,reservation_id,inventory_id) values($1,$2,$3)', [full, reservation, fixtureInventory]);
assert.equal(await count('agency_inventory_categories', full), 7);
assert.equal(await count('agency_inventory', full), 4);
assert.equal(await count('agency_inventory_reservations', full), 3);
assert.equal(await count('agency_inventory_reservation_items', full), 5);
assert.equal(await count('agency_work_checklists', full), 80);
assert.equal(await count('agency_work_checklist_items', full), 241);
const payment = (await query('select id from agency_payments where organization_id=$1 order by id limit 1', [full])).rows[0].id;
await query("insert into agency_payment_reversals(organization_id,payment_id,reason,created_by_user_id) values($1,$2,'Test reversal',$3)", [full, payment, owner]);
const auditBefore = await count('agency_operation_audit', full);
const usersBefore = (await query('select * from users order by id')).rows;
let result = await runMaintenance(db, {env: {}});
assert.equal(result.dryRun, true);
assert.equal(result.demos.find(d => d.organizationId === full)?.status, 'eligible');
assert.ok(await count('agency_payments', full));
const scheduledMode = await maintenance(db, {dryRun: false, env: {}});
assert.equal(scheduledMode.demoDryRun, true);
assert.equal(scheduledMode.demos.find(d => d.organizationId === full)?.status, 'eligible');
assert.ok(await count('agency_payments', full));
await assert.rejects(maintenance(db, {dryRun: false, demoDryRun: false, env: {DATABASE_URL: fixtureDatabase}}), /VERIFIED_BACKUP_REQUIRED/);
await assert.rejects(maintenance(db, {dryRun: false, demoDryRun: false, env: {DATABASE_URL: fixtureDatabase}, verifiedBackup: {...fixtureEvidence, verifiedAt: '2020-01-01'}}), /VERIFIED_BACKUP_REQUIRED/);
await assert.rejects(maintenance(db, {dryRun: false, demoDryRun: false, env: {DATABASE_URL: fixtureDatabase}, verifiedBackup: {...fixtureEvidence, backupCreatedAt: '2020-01-01'}}), /VERIFIED_BACKUP_REQUIRED/);
await assert.rejects(maintenance(db, {dryRun: false, demoDryRun: false, env: {DATABASE_URL: fixtureDatabase + '-other'}, verifiedBackup: fixtureEvidence}), /VERIFIED_BACKUP_REQUIRED/);
result = await runMaintenance(db, {dryRun: false, env: {}});
assert.equal(result.demos.find(d => d.organizationId === full)?.status, 'deleted', JSON.stringify(result));
assert.equal(await count('agency_payments', full), 0);
assert.equal((await query('select id from organizations where id=$1', [full])).rows.length, 0);
assert.ok(await count('agency_operation_audit', full) > auditBefore);
assert.deepEqual((await query('select * from users order by id')).rows, usersBefore);
assert.deepEqual((await query('select * from user_personal_identities order by user_id')).rows, identitiesBefore);
assert.equal(await count('agency_inventory_reservations', full), 0);
assert.equal(await count('agency_project_assignees', full), 0);
assert.equal(await count('agency_work_checklist_items', full), 0);
assert.equal(await count('agency_work_checklists', full), 0);
assert.deepEqual(await capture(), baseline);
assert.deepEqual((await runMaintenance(db, {dryRun: false, env: {}})).demos, []);
for (const sql of ["delete from agency_payments where organization_id=$1", "delete from account_transfers where organization_id=$1"])
 await assert.rejects(query(sql, [real]), /immutable/);

// Missing markers, active sessions, grace period, other members and protected ID.
const keep = [];
for (const mutation of [
 "demo_source_id=null", "demo_owner_user_id=null", "demo_expires_at=null", "demo_expires_at=now()-interval '1 hour'",
 "demo_expires_at=now()+interval '1 day'", "slug='demo-session-not-a-uuid'",
]) { const id = await fixture(); keep.push(id); await query(`update organizations set ${mutation} where id=$1`, [id]); }
const missingSession = await fixture(); keep.push(missingSession);
await query('delete from agency_demo_sessions where organization_id=$1', [missingSession]);
const active = await fixture(); keep.push(active);
await query("insert into sessions(id,user_id,organization_id,expires_at) values('active-demo',$1,$2,now()+interval '1 day')", [owner, active]);
const foreignMember = await fixture(); keep.push(foreignMember);
const outsider = await insert("insert into users(email,password_hash) values('real-member@example.invalid','canonical')");
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')", [foreignMember, outsider]);
assert.equal((await runMaintenance(db, {dryRun: false, env: {}})).demos.length, 0);
for (const id of keep) assert.equal((await query('select id from organizations where id=$1', [id])).rows.length, 1);
// Even a fully marked, expired organization 22 is categorically protected.
await query("update organizations set slug=$1,demo_owner_user_id=$2,demo_source_id=$3 where id=22", ['demo-session-' + randomUUID(), owner, template]);
await query("insert into organization_members(organization_id,user_id,role) values(22,$1,'owner')", [owner]);
await query("insert into agency_demo_sessions(demo_key,user_id,organization_id) values('protected-template',$1,22)", [owner]);
await expired(22);
assert.equal((await runMaintenance(db, {dryRun: false, env: {}})).demos.length, 0);
assert.equal((await query('select id from organizations where id=22')).rows.length, 1);

// Anonymous demos have no agency_demo_sessions row; their own independent markers apply.
const guestUuid = randomUUID();
const guest = await insert("insert into users(email,password_hash,is_demo_guest) values($1,'!public-demo-no-login',true)", ['visitante-' + guestUuid + '@demo.example.invalid']);
const publicOrg = await insert("insert into organizations(slug,name,demo_owner_user_id) values($1,'Public fixture',$2)", ['demo-session-' + guestUuid, guest]);
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')", [publicOrg, guest]);
await expired(publicOrg);
assert.equal((await runMaintenance(db, {dryRun: false, env: {}})).demos[0].status, 'deleted');
assert.equal((await query('select id from users where id=$1', [guest])).rows.length, 1);

// Existing cross-tenant ON DELETE CASCADE must abort, preserving all rows.
const crossed = await fixture();
const client = await insert("insert into agency_clients(organization_id,name) values($1,'Demo client')", [crossed]);
const project = await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Demo project')", [crossed, client]);
const otherOrder = await insert("insert into agency_work_orders(organization_id,project_id,title) values($1,$2,'Outside fixture')", [real, project]);
result = await runMaintenance(db, {dryRun: false, env: {}});
assert.equal(result.demos[0].reason, 'CROSS_TENANT_REFERENCE');
assert.equal((await query('select id from agency_work_orders where id=$1', [otherOrder])).rows.length, 1);
// Unknown table refuses automatic cascade even when the row claims the demo org.
await pg.exec('create table unowned_demo_data(id int primary key, organization_id bigint references organizations(id) on delete cascade)');
const unknown = await fixture();
await query('insert into unowned_demo_data values(1,$1)', [unknown]);
result = await runMaintenance(db, {dryRun: false, env: {}});
assert.equal(result.demos.find(d => d.organizationId === unknown).reason, 'UNOWNED_REFERENCE');
await query("insert into live_visitor_sites(site_key,organization_id,label,origins,request_hosts) values('must-preserve',$1,'Not a demo fixture','{}','{}')", [unknown]);
await query('delete from unowned_demo_data where id=1');
result = await runMaintenance(db, {dryRun: false, env: {}});
assert.equal(result.demos.find(d => d.organizationId === unknown).reason, 'UNOWNED_REFERENCE');
assert.equal((await query("select site_key from live_visitor_sites where site_key='must-preserve'")).rows.length, 1);

// Any failure after trigger suspension must roll back data, audit, and trigger DDL.
const rollbackOrg = await fixture();
await pg.exec(`create function maintenance_test_reject() returns trigger language plpgsql as $$ begin
 if old.id=${rollbackOrg} then raise exception 'test failure'; end if; return old; end $$;
 create trigger maintenance_test_reject before delete on organizations for each row execute function maintenance_test_reject()`);
result = await runMaintenance(db, {dryRun: false, env: {DEMO_CLEANUP_BATCH_SIZE: '20'}});
assert.equal(result.demos.find(d => d.organizationId === rollbackOrg).status, 'blocked');
assert.equal(await count('organization_members', rollbackOrg), 1);
assert.equal((await query("select tgname from pg_trigger where not tgisinternal and tgenabled<>'O'")).rows.length, 0);
await pg.exec('drop trigger maintenance_test_reject on organizations; drop function maintenance_test_reject()');

// Bounded retention uses last activity (not login start), configurable 30/90 days.
for (const [key, age] of [['old', 100], ['mid', 45], ['fresh', 1]]) {
 await query("insert into agency_usage_sessions(organization_id,user_id,session_key,first_seen_at,last_seen_at) values($1,$2,$3,now()-interval '200 days',now()-$4::int*interval '1 day')", [real, owner, key, age]);
 await query("insert into agency_presence_tabs(organization_id,user_id,tab_id,last_seen_at) values($1,$2,$3,now()-$4::int*interval '1 day')", [real, owner, randomUUID(), age]);
}
result = await runMaintenance(db, {env: {PRESENCE_CLEANUP_BATCH_SIZE: '1'}});
assert.equal(result.presenceTabs, 1); assert.equal(result.usageSessions, 1);
assert.equal(await count('agency_presence_tabs', real), 3);
result = await runMaintenance(db, {dryRun: false, env: {PRESENCE_CLEANUP_BATCH_SIZE: '1'}});
assert.equal(result.presenceTabs, 1); assert.equal(result.usageSessions, 1);
assert.equal(await count('agency_usage_sessions', real), 2);
result = await runMaintenance(db, {dryRun: false, env: {PRESENCE_RETENTION_DAYS: '60', USAGE_RETENTION_DAYS: '30'}});
assert.equal(result.presenceTabs, 0); assert.equal(result.usageSessions, 1);
assert.equal(await count('agency_usage_sessions', real), 1);
assert.equal(maintenanceSettings({}).graceHours, 24);
for (const env of [{DEMO_CLEANUP_GRACE_HOURS: '0'}, {PRESENCE_RETENTION_DAYS: ''}, {USAGE_RETENTION_DAYS: 'NaN'}, {DEMO_CLEANUP_BATCH_SIZE: '500'}])
 assert.throws(() => maintenanceSettings(env), /INVALID/);
// Enforced row cap and demo cap; dry runs cannot be accidentally enabled by strings.
const oversized = await fixture();
result = await runMaintenance(db, {env: {DEMO_CLEANUP_MAX_ROWS: '1', DEMO_CLEANUP_BATCH_SIZE: '20'}});
assert.equal(result.demos.find(d => d.organizationId === oversized).reason, 'DEMO_ROW_LIMIT');
assert.ok((await runMaintenance(db, {env: {DEMO_CLEANUP_BATCH_SIZE: '1'}})).demos.length <= 1);
await assert.rejects(runMaintenance(db, {dryRun: 'false', env: {}}), /INVALID_DRY_RUN/);
let released = false;
const busyDb = {connect: async () => ({query: async (sql, values) => sql.includes('pg_try_advisory_xact_lock') ? {rows: [{locked: false}]} : query(sql, values), release() { released = true; }})};
assert.equal((await runMaintenance(busyDb, {env: {}})).skipped, 'busy'); assert.equal(released, true);
// Scheduling is opt-in, starts immediately, deduplicates startup and catches failures.
let scheduled = 0, cleared = 0, connects = 0, callback;
const schedulerDb = {connect: async () => { connects++; throw Error('private connection details'); }};
const logs = [], timers = {setInterval(fn) { scheduled++; callback = fn; return {unref() {}}; }, clearInterval() { cleared++; }};
startMaintenance(schedulerDb, {env: {}, timers}); assert.equal(scheduled, 0);
assert.doesNotThrow(() => startMaintenance(schedulerDb, {env: {MAINTENANCE_ENABLED: 'false', PRESENCE_RETENTION_DAYS: 'bad'}, timers}));
assert.equal(scheduled, 0); assert.equal(connects, 0, 'disabled maintenance must not validate unused settings or connect');
assert.throws(() => startMaintenance(schedulerDb, {env: {MAINTENANCE_ENABLED: 'true', PRESENCE_RETENTION_DAYS: 'bad'}, timers}), /INVALID_PRESENCE_DAYS/);
const options = {env: {MAINTENANCE_ENABLED: 'true'}, timers, log: value => logs.push(value)};
const stop = startMaintenance(schedulerDb, options);
assert.equal(startMaintenance(schedulerDb, options), stop); assert.equal(scheduled, 1);
await new Promise(resolve => setImmediate(resolve));
assert.equal(connects, 1); assert.deepEqual(logs, ['{"event":"maintenance_failed"}']);
callback(); callback(); await new Promise(resolve => setImmediate(resolve)); assert.equal(connects, 2);
stop(); assert.equal(cleared, 1); callback(); assert.equal(connects, 2);
await pg.close();
console.log('PASS: expired private/public demos, grace and markers, canonical users and real finance preserved, FK/cascade refusal, rollback restores immutable guards, bounded configurable retention, dry-run, idempotency and scheduling');
