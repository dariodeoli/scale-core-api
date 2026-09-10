import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {r2Config, checkReadiness, uploadBackup, verifyBackup, validateManifest, databaseConfig} from './scripts/r2-backup.mjs';

const env = {
 R2_ENDPOINT_URL: 'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com',
 R2_BUCKET: 'scale-backup-test', R2_BACKUP_PREFIX: 'scale/postgres',
 R2_ACCESS_KEY_ID: 'test-access-placeholder', R2_SECRET_ACCESS_KEY: 'test-secret-placeholder',
 DATABASE_URL: 'postgres://test:source-placeholder@source.invalid/scale',
 R2_RESTORE_ADMIN_URL: 'postgres://test:scratch-placeholder@scratch.invalid/postgres',
};
assert.throws(() => r2Config({}), e => e.backupCode === 'MISSING_CONFIG' && e.missing.includes('DATABASE_URL'));
for (const value of ['http://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com', 'https://evil.invalid', env.R2_ENDPOINT_URL + '/bucket', env.R2_ENDPOINT_URL + '?leak=true'])
 assert.throws(() => r2Config({...env, R2_ENDPOINT_URL: value}), /INVALID_R2_ENDPOINT/);
for (const value of ['../escape', 'scale/', '--option', 'scale?secret'])
 assert.throws(() => r2Config({...env, R2_BACKUP_PREFIX: value}), /INVALID_R2_PREFIX/);
assert.throws(() => databaseConfig(env.DATABASE_URL + '?host=elsewhere'), /UNSUPPORTED_DATABASE_OPTION/);
assert.throws(() => databaseConfig('not-a-url'), /INVALID_DATABASE_URL/);

const objects = new Map(), commands = [], sql = [], tempFiles = new Set();
let fingerprintMismatch = false, restoreFailure = false, manifestFailure = false;
let createCount = 0, dropCount = 0;
class Client {
 constructor(options) { this.source = options.connectionString.includes('source.invalid'); }
 async connect() {}
 async end() {}
 async query(text) {
  sql.push(text);
  if (text.includes('pg_export_snapshot')) return {rows: [{id: 'test-snapshot'}]};
  if (text.includes('from pg_tables')) return {rows: [{schema: 'public', name: 'organizations'}]};
  if (text.includes('row_to_json')) return {rows: [{count: '2', digest: (fingerprintMismatch && !this.source ? 'b' : 'a').repeat(32)}]};
  if (text.includes('from pg_roles')) return {rows: [{rolsuper: false, rolcreatedb: true}]};
  if (text.includes('from pg_constraint')) return {rows: [{n: 0}]};
  if (text.startsWith('create database')) { createCount++; assert.match(text, /^create database "scale_r2_verify_[a-f0-9]{24}" template template0$/); }
  if (text.startsWith('drop database')) { dropCount++; assert.match(text, /^drop database "scale_r2_verify_[a-f0-9]{24}"$/); }
  return {rows: []};
 }
}
async function run(command, args, options) {
 commands.push({command, args, options});
 assert.equal(options.shell, undefined);
 for (const secret of ['test-access-placeholder', 'test-secret-placeholder', 'source-placeholder', 'scratch-placeholder'])
  assert.ok(!JSON.stringify(args).includes(secret), 'secrets must not be passed in argv');
 assert.equal(options.env.DATABASE_URL, undefined);
 if (command === 'pg_dump') {
  assert.ok(args.includes('--snapshot=test-snapshot')); assert.ok(args.includes('--format=custom'));
  assert.equal(options.env.PGPASSWORD, 'source-placeholder');
  const file = args.find(a => a.startsWith('--file=')).slice(7); tempFiles.add(file);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.writeFile(file, 'PGDMP-test-archive-bytes');
 } else if (command === 'aws') {
  const key = args[args.indexOf('--key') + 1], mode = args[1];
  assert.equal(options.env.AWS_SECRET_ACCESS_KEY, env.R2_SECRET_ACCESS_KEY);
  assert.equal(options.env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
  assert.equal(options.env.AWS_EC2_METADATA_DISABLED, 'true');
  if (mode === 'put-object') {
   assert.ok(args.includes('--if-none-match')); assert.ok(args.includes('*'));
   const file = args[args.indexOf('--body') + 1]; tempFiles.add(file);
   if (manifestFailure && key.endsWith('.json')) throw Error('provider secret must never be printed');
   assert.equal(objects.has(key), false, 'never overwrite a remote key');
   objects.set(key, await fs.readFile(file));
  } else {
   assert.equal(mode, 'get-object');
   const file = args.at(-1); tempFiles.add(file);
   assert.equal((await fs.stat(file.substring(0, file.lastIndexOf('/')))).mode & 0o777, 0o700);
   await fs.writeFile(file, objects.get(key));
  }
 } else if (command === 'pg_restore') {
  assert.ok(args.includes('--single-transaction')); assert.ok(args.includes('--exit-on-error'));
  assert.ok(!args.includes('--clean')); assert.ok(!args.includes('--create'));
  assert.match(options.env.PGDATABASE, /^scale_r2_verify_[a-f0-9]{24}$/);
  assert.equal(options.env.PGHOST, 'scratch.invalid');
  if (restoreFailure) throw Error('restore failed');
 } else assert.fail('Unexpected external command');
 return {stdout: '', stderr: ''};
}
const uploaded = await uploadBackup({env, run, Client});
assert.equal(uploaded.externalBackupVerified, false);
assert.equal(objects.size, 2);
assert.ok(sql.includes('begin isolation level repeatable read read only'));
assert.ok(sql.includes('commit'));
const id = uploaded.backupId, manifestKey = env.R2_BACKUP_PREFIX + '/' + id + '.json', dumpKey = env.R2_BACKUP_PREFIX + '/' + id + '.dump';
const manifest = JSON.parse(objects.get(manifestKey));
assert.equal(manifest.bytes, Buffer.byteLength('PGDMP-test-archive-bytes'));
assert.equal(validateManifest(manifest, id), manifest);
assert.throws(() => validateManifest({...manifest, tables: [...manifest.tables, ...manifest.tables]}, id), /INVALID_MANIFEST/);
const verified = await verifyBackup(id, {env, run, Client});
assert.equal(verified.externalBackupVerified, true); assert.equal(createCount, 1); assert.equal(dropCount, 1);
assert.ok(!commands.some(({args}) => args.some(a => ['delete-object','delete-objects','sync','--acl'].includes(a))));
for (const file of tempFiles) await assert.rejects(fs.stat(file), {code: 'ENOENT'});

// Corruption or wrong destination must fail before creating any scratch database.
const original = objects.get(dumpKey); objects.set(dumpKey, Buffer.from('tampered bytes'));
await assert.rejects(verifyBackup(id, {env, run, Client}), /ARCHIVE_CHECKSUM_MISMATCH/); assert.equal(createCount, 1);
objects.set(dumpKey, original);
await assert.rejects(verifyBackup('../other-object', {env, run, Client}), /INVALID_BACKUP_ID/);
await assert.rejects(verifyBackup(id, {env: {...env, R2_RESTORE_ADMIN_URL: env.DATABASE_URL}, run, Client}), /RESTORE_HOST_IS_SOURCE/);
assert.equal(createCount, 1);
fingerprintMismatch = true;
await assert.rejects(verifyBackup(id, {env, run, Client}), /RESTORED_DATA_MISMATCH/); assert.equal(dropCount, 2);
fingerprintMismatch = false; restoreFailure = true;
await assert.rejects(verifyBackup(id, {env, run, Client}), /restore failed/); assert.equal(dropCount, 3);
restoreFailure = false; manifestFailure = true;
await assert.rejects(uploadBackup({env, run, Client}), /provider secret/);
assert.equal([...objects.keys()].filter(k => k.endsWith('.json')).length, 1, 'partial upload has no manifest');
for (const file of tempFiles) await assert.rejects(fs.stat(file), {code: 'ENOENT'});
const check = await checkReadiness({}, async () => { throw Error('missing tool'); });
assert.equal(check.externalBackupVerified, false);
assert.equal(check.tools.aws, false); assert.ok(check.verify.missing.includes('R2_RESTORE_ADMIN_URL'));
const invalidCli = spawnSync(process.execPath, ['scripts/r2-backup.mjs', '--upload'], {encoding: 'utf8', env: {PATH: process.env.PATH}});
assert.equal(invalidCli.status, 1); assert.match(invalidCli.stderr, /MISSING_CONFIG/);
assert.ok(!invalidCli.stderr.includes('Error:'));
console.log('PASS: R2 readiness/config validation, safe argv/env, unique non-overwriting uploads, consistent snapshot manifest, round-trip orchestration, checksum/data mismatch refusal, separate scratch host, scratch/temp cleanup and sanitized CLI failures (mocked external services)');
