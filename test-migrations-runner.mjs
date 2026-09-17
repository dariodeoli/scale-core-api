import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {applyPendingMigrations} from './migrations-runner.mjs';

const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scale-migrations-'));
await fs.promises.writeFile(path.join(dir, '20260101_alpha.sql'), 'create table sample(id int primary key);');
await fs.promises.writeFile(path.join(dir, '20260101_alpha 2.sql'), 'create table never_applied(id int);');
await fs.promises.writeFile(path.join(dir, '20260102_beta.sql'), 'alter table sample add column label text;');

// Fresh database without a baseline: every file in the directory runs once.
const fresh = new PGlite();
const freshClient = {query: (sql, values) => fresh.query(sql, values)};
const first = await applyPendingMigrations(freshClient, dir);
assert.equal((await freshClient.query("select to_regclass('public.never_applied') as name")).rows[0].name, null, 'non-conventional file names are never applied');
assert.deepEqual(first, ['20260101_alpha.sql', '20260102_beta.sql'], 'a fresh tracker applies every file in order');
assert.equal((await freshClient.query("select to_regclass('public.sample') as name")).rows[0].name, 'sample');
await fresh.close();

// Database migrated before the tracker existed: the explicit baseline is recorded
// as applied and only files beyond it run.
const pg = new PGlite();
const client = {query: (sql, values) => pg.query(sql, values)};
await client.query(await fs.promises.readFile(path.join(dir, '20260101_alpha.sql'), 'utf8'));
const baseline = await applyPendingMigrations(client, dir, {knownFiles: ['20260101_alpha.sql']});
assert.deepEqual(baseline, ['20260102_beta.sql'], 'only files beyond the explicit baseline run');
assert.equal((await client.query('select filename from schema_migrations order by filename')).rows.map(row => row.filename).join(','), '20260101_alpha.sql,20260102_beta.sql');

// Idempotent: a second run never replays a recorded migration.
const second = await applyPendingMigrations(client, dir, {knownFiles: ['20260101_alpha.sql']});
assert.deepEqual(second, [], 'recorded migrations are never replayed');

// A new file added later is the only pending migration on the next startup.
await fs.promises.writeFile(path.join(dir, '20260103_gamma.sql'), 'alter table sample add column amount int not null default 0;');
const third = await applyPendingMigrations(client, dir, {knownFiles: ['20260101_alpha.sql']});
assert.deepEqual(third, ['20260103_gamma.sql'], 'only the new migration runs on the next startup');
assert.equal((await client.query('select count(*)::int as n from schema_migrations')).rows[0].n, 3);
await pg.close();

// Rollout mode: existing databases record today's files as the baseline and
// never replay them, so only future files run.
const roll = new PGlite();
const rollClient = {query: (sql, values) => roll.query(sql, values)};
for (const name of ['20260101_alpha.sql', '20260102_beta.sql', '20260103_gamma.sql']) await rollClient.query(await fs.promises.readFile(path.join(dir, name), 'utf8'));
const rollFirst = await applyPendingMigrations(rollClient, dir, {firstRun: 'baseline'});
assert.deepEqual(rollFirst, [], 'baseline mode records every current file without executing it');
await fs.promises.writeFile(path.join(dir, '20260104_delta.sql'), 'alter table sample add column extra text;');
const rollNext = await applyPendingMigrations(rollClient, dir, {firstRun: 'baseline'});
assert.deepEqual(rollNext, ['20260104_delta.sql'], 'files added after the rollout are the only ones pending');
await roll.close();

// The repository directory stays clean: every real migration is listed and no
// duplicated " 2" copies are tracked.
const repoDir = new URL('./migrations', import.meta.url).pathname;
const conventional = /^\d{8}_[a-z0-9_]+\.sql$/;
const files = (await fs.promises.readdir(repoDir)).filter(name => conventional.test(name));
assert(files.length >= 60, `the repository keeps every migration file (saw ${files.length})`);
assert(files.includes('20260916_identity_photo_removal.sql'), 'the latest identity migration is present');
assert.equal(new Set(files).size, files.length, 'no duplicated migration names are tracked');

console.log('PASS: migration runner applies pending files once, records the explicit baseline and ignores duplicated copies.');
