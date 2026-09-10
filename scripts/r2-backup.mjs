// Manual, explicit commands. No remote deletions, credential creation or startup effects.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';

const execute = promisify(execFile);
const required = ['R2_ENDPOINT_URL', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BACKUP_PREFIX'];
const backupIdPattern = /^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const quote = v => '"' + v.replaceAll('"', '""') + '"';
const fail = code => Object.assign(new Error(code), {backupCode: code});
export function r2Config(env = process.env, mode = 'upload') {
 const names = [...required, mode === 'verify' ? 'R2_RESTORE_ADMIN_URL' : 'DATABASE_URL'];
 const missing = names.filter(k => !env[k]?.trim());
 if (missing.length) throw Object.assign(fail('MISSING_CONFIG'), {missing});
 let endpoint;
 try { endpoint = new URL(env.R2_ENDPOINT_URL); } catch { throw fail('INVALID_R2_ENDPOINT'); }
 if (endpoint.protocol !== 'https:' || !/^[a-f0-9]{32}(\.(eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname)
  || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw fail('INVALID_R2_ENDPOINT');
 if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET)) throw fail('INVALID_R2_BUCKET');
 if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,120}$/.test(env.R2_BACKUP_PREFIX) || env.R2_BACKUP_PREFIX.endsWith('/')) throw fail('INVALID_R2_PREFIX');
 const database = databaseConfig(env[mode === 'verify' ? 'R2_RESTORE_ADMIN_URL' : 'DATABASE_URL']);
 return {endpoint: endpoint.origin, bucket: env.R2_BUCKET, prefix: env.R2_BACKUP_PREFIX, database};
}
export function databaseConfig(value) {
 let url;
 try { url = new URL(value); } catch { throw fail('INVALID_DATABASE_URL'); }
 if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2 || url.hash) throw fail('INVALID_DATABASE_URL');
 // Host overrides / libpq options would invalidate scratch-host isolation checks.
 for (const key of url.searchParams.keys()) if (!['sslmode', 'sslrootcert'].includes(key)) throw fail('UNSUPPORTED_DATABASE_OPTION');
 const sslmode = url.searchParams.get('sslmode') || 'prefer';
 if (!['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(sslmode)) throw fail('INVALID_SSL_MODE');
 return {url, env: {
  PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGSSLMODE: sslmode, ...(url.searchParams.has('sslrootcert') ? {PGSSLROOTCERT: url.searchParams.get('sslrootcert')} : {}),
  PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'scale-r2-backup',
 }};
}
const hostIdentity = database => crypto.createHash('sha256').update(database.env.PGHOST + ':' + database.env.PGPORT).digest('hex');
const databaseIdentity = database => crypto.createHash('sha256').update(database.env.PGHOST + ':' + database.env.PGPORT + '/' + database.env.PGDATABASE).digest('hex');
function childEnv(env, extra = {}) {
 // Credentials travel only in environment variables, never argv or console output.
 return {PATH: env.PATH || process.env.PATH, LANG: 'C.UTF-8', ...extra};
}
function awsEnv(env) {
 return childEnv(env, {
  AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
  AWS_DEFAULT_REGION: 'auto', AWS_EC2_METADATA_DISABLED: 'true', AWS_MAX_ATTEMPTS: '2',
  AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_PAGER: '',
  AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
 });
}
function awsArgs(config, operation, key, file) {
 const args = ['s3api', operation, '--endpoint-url', config.endpoint, '--region', 'auto', '--bucket', config.bucket, '--key', key];
 return operation === 'put-object' ? [...args, '--body', file, '--if-none-match', '*'] : [...args, file];
}
async function digest(file) {
 const hash = crypto.createHash('sha256'); let bytes = 0;
 for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
 return {sha256: hash.digest('hex'), bytes};
}
async function fingerprint(client, schema, table) {
 return (await client.query(`select count(*)::text as count,
 md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as digest
 from ${quote(schema)}.${quote(table)} t`)).rows[0];
}
const tableSql = `select schemaname as schema,tablename as name from pg_tables
 where schemaname not in ('pg_catalog','information_schema') and schemaname not like 'pg_toast%'
 order by schemaname,tablename`;
export async function checkReadiness(env = process.env, run = execute) {
 const checks = {};
 for (const mode of ['upload', 'verify']) {
  try { r2Config(env, mode); checks[mode] = {configured: true}; }
  catch (error) { checks[mode] = {configured: false, code: error.backupCode, missing: error.missing || []}; }
 }
 checks.tools = {};
 for (const command of ['aws', 'pg_dump', 'pg_restore']) {
  try { await run(command, ['--version'], {timeout: 5000, maxBuffer: 4096, env: childEnv(env)}); checks.tools[command] = true; }
  catch { checks.tools[command] = false; }
 }
 return {event: 'r2_readiness', ...checks, externalBackupVerified: false};
}
export async function uploadBackup({env = process.env, run = execute, Client = pg.Client} = {}) {
 const config = r2Config(env, 'upload');
 const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') + '-' + crypto.randomUUID();
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scale-r2-upload-'));
 const dump = path.join(dir, 'backup.dump'), manifestPath = path.join(dir, 'manifest.json');
 const client = new Client({connectionString: config.database.url.href, connectionTimeoutMillis: 10000, statement_timeout: 180000});
 let connected = false, tx = false;
 try {
  await fs.chmod(dir, 0o700);
  await client.connect(); connected = true;
  await client.query('begin isolation level repeatable read read only'); tx = true;
  await client.query("set local timezone='UTC'");
  await client.query("set local datestyle='ISO, YMD'");
  const snapshot = (await client.query('select pg_export_snapshot() as id')).rows[0].id;
  const tables = (await client.query(tableSql)).rows;
  if (!tables.length) throw fail('EMPTY_SOURCE');
  const records = [];
  for (const table of tables) records.push({...table, ...await fingerprint(client, table.schema, table.name)});
  await fs.writeFile(dump, '', {mode: 0o600, flag: 'wx'});
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--snapshot=' + snapshot, '--file=' + dump],
   {env: childEnv(env, config.database.env), timeout: 180000, maxBuffer: 1024 * 1024});
  await client.query('commit'); tx = false;
  const content = await digest(dump);
  if (!content.bytes) throw fail('EMPTY_DUMP');
  const manifest = {version: 1, backupId: id, createdAt: new Date().toISOString(), sourceHostHash: hostIdentity(config.database),
   sourceDatabaseHash: databaseIdentity(config.database), ...content, tables: records};
  await fs.writeFile(manifestPath, JSON.stringify(manifest), {mode: 0o600, flag: 'wx'});
  const options = {env: awsEnv(env), timeout: 180000, maxBuffer: 65536};
  // Manifest is published last. A partial upload is not a completed backup.
  await run('aws', awsArgs(config, 'put-object', config.prefix + '/' + id + '.dump', dump), options);
  await run('aws', awsArgs(config, 'put-object', config.prefix + '/' + id + '.json', manifestPath), options);
  return {event: 'r2_backup_uploaded', backupId: id, bytes: content.bytes, tables: records.length, externalBackupVerified: false};
 } finally {
  if (tx) await client.query('rollback').catch(() => {});
  if (connected) await client.end().catch(() => {});
  for (const file of [dump, manifestPath]) await fs.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
  await fs.rmdir(dir);
 }
}
export function validateManifest(manifest, id) {
 if (manifest.version !== 1 || manifest.backupId !== id || !backupIdPattern.test(id)
  || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0
  || !/^[a-f0-9]{64}$/.test(manifest.sourceHostHash) || !/^[a-f0-9]{64}$/.test(manifest.sourceDatabaseHash)
  || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.tables) || !manifest.tables.length
  || manifest.tables.some(t => typeof t.schema !== 'string' || !t.schema || typeof t.name !== 'string' || !t.name
   || !/^\d+$/.test(t.count) || !/^[a-f0-9]{32}$/.test(t.digest))) throw fail('INVALID_MANIFEST');
 if (new Set(manifest.tables.map(t => JSON.stringify([t.schema, t.name]))).size !== manifest.tables.length) throw fail('INVALID_MANIFEST');
 return manifest;
}
export async function verifyBackup(id, {env = process.env, run = execute, Client = pg.Client} = {}) {
 if (!backupIdPattern.test(id)) throw fail('INVALID_BACKUP_ID');
 const config = r2Config(env, 'verify');
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scale-r2-verify-'));
 const dump = path.join(dir, 'backup.dump'), manifestPath = path.join(dir, 'manifest.json');
 const scratchName = 'scale_r2_verify_' + crypto.randomBytes(12).toString('hex');
 const admin = new Client({connectionString: config.database.url.href, connectionTimeoutMillis: 10000, statement_timeout: 180000});
 let connected = false, created = false, restored;
 try {
  await fs.chmod(dir, 0o700);
  const options = {env: awsEnv(env), timeout: 180000, maxBuffer: 65536};
  await run('aws', awsArgs(config, 'get-object', config.prefix + '/' + id + '.json', manifestPath), options);
  if ((await fs.stat(manifestPath)).size > 5 * 1024 * 1024) throw fail('MANIFEST_TOO_LARGE');
  const manifest = validateManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')), id);
  // Never restore on the backed-up host, even into a different database.
  if (manifest.sourceHostHash === hostIdentity(config.database)) throw fail('RESTORE_HOST_IS_SOURCE');
  if (env.DATABASE_URL && hostIdentity(databaseConfig(env.DATABASE_URL)) === hostIdentity(config.database)) throw fail('RESTORE_HOST_IS_SOURCE');
  await run('aws', awsArgs(config, 'get-object', config.prefix + '/' + id + '.dump', dump), options);
  const actual = await digest(dump);
  if (actual.bytes !== manifest.bytes || actual.sha256 !== manifest.sha256) throw fail('ARCHIVE_CHECKSUM_MISMATCH');
  await admin.connect(); connected = true;
  const role = (await admin.query('select rolsuper,rolcreatedb from pg_roles where rolname=current_user')).rows[0];
  if (!role || role.rolsuper || !role.rolcreatedb) throw fail('RESTORE_ROLE_REQUIRES_NONSUPERUSER_CREATEDB');
  await admin.query(`create database ${quote(scratchName)} template template0`); created = true;
  await run('pg_restore', ['--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', '--dbname=' + scratchName, dump],
   {env: childEnv(env, {...config.database.env, PGDATABASE: scratchName}), timeout: 180000, maxBuffer: 1024 * 1024});
  const scratchUrl = new URL(config.database.url); scratchUrl.pathname = '/' + scratchName;
  restored = new Client({connectionString: scratchUrl.href, connectionTimeoutMillis: 10000, statement_timeout: 180000});
  await restored.connect();
  await restored.query("set timezone='UTC'");
  await restored.query("set datestyle='ISO, YMD'");
  const tables = (await restored.query(tableSql)).rows;
  if (JSON.stringify(tables) !== JSON.stringify(manifest.tables.map(({schema, name}) => ({schema, name})))) throw fail('TABLE_SET_MISMATCH');
  for (const t of manifest.tables) {
   const actual = await fingerprint(restored, t.schema, t.name);
   if (actual.count !== t.count || actual.digest !== t.digest) throw fail('RESTORED_DATA_MISMATCH');
  }
  const invalid = (await restored.query(`select count(*)::int as n from pg_constraint c
   join pg_namespace ns on ns.oid=c.connamespace where not c.convalidated
   and ns.nspname not in ('pg_catalog','information_schema')`)).rows[0].n;
  if (invalid) throw fail('UNVALIDATED_CONSTRAINTS');
  return {event: 'r2_restore_verified', backupId: id, verifiedAt: new Date().toISOString(),
   sourceHostHash: manifest.sourceHostHash, sourceDatabaseHash: manifest.sourceDatabaseHash,
   backupCreatedAt: manifest.createdAt, tables: tables.length, bytes: actual.bytes, externalBackupVerified: true};
 } finally {
  await restored?.end().catch(() => {});
  // Exact random database created by this invocation only. No FORCE, no production target.
  try { if (created) await admin.query(`drop database ${quote(scratchName)}`); }
  catch { throw Object.assign(fail('SCRATCH_CLEANUP_FAILED'), {scratchDatabase: scratchName}); }
  finally {
   if (connected) await admin.end().catch(() => {});
   for (const file of [dump, manifestPath]) await fs.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
   await fs.rmdir(dir);
  }
 }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try {
  const [mode, id, ...extra] = process.argv.slice(2);
  if (extra.length || (mode !== '--verify' && id) || !['--check', '--upload', '--verify'].includes(mode)) throw fail('USAGE: --check | --upload | --verify BACKUP_ID');
  const result = mode === '--check' ? await checkReadiness() : mode === '--upload' ? await uploadBackup() : await verifyBackup(id);
  console.log(JSON.stringify(result));
  if (mode === '--check' && (!result.upload.configured || !result.verify.configured || Object.values(result.tools).some(v => !v))) process.exitCode = 1;
 } catch (error) {
  // Never print child-process errors, stderr, command strings, database URLs or tokens.
  console.error(JSON.stringify({event: 'r2_backup_failed', code: error.backupCode || 'OPERATION_FAILED',
   ...(error.missing ? {missing: error.missing} : {}), ...(error.scratchDatabase ? {scratchDatabase: error.scratchDatabase} : {})}));
  process.exitCode = 1;
 }
}
