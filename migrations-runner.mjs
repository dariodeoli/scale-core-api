import fs from 'node:fs';
import path from 'node:path';

// Applies every .sql file in the migrations directory exactly once, in file-name
// order, and records it in schema_migrations. `knownFiles` names the migrations
// the caller already applies explicitly: on the first run of the tracker they
// are recorded as applied so only files beyond that baseline execute.
export async function applyPendingMigrations(client, directory, {knownFiles = [], firstRun = 'apply'} = {}) {
  // PGlite rejects multi-statement SQL through query(); exec() mirrors the
  // simple-query path that a real PostgreSQL client already provides.
  const run = sql => typeof client.exec === 'function' ? client.exec(sql) : client.query(sql);
  await client.query('create table if not exists schema_migrations(filename text primary key, applied_at timestamptz not null default now())');
  const applied = new Set((await client.query('select filename from schema_migrations')).rows.map(row => row.filename));
  const files = (await fs.promises.readdir(directory)).filter(name => /^\d{8}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!applied.size && (knownFiles.length || firstRun === 'baseline')) {
    // Databases that were migrated before the tracker existed already ran every
    // file present at rollout time: record the baseline and only run new files.
    const baseline = knownFiles.length ? knownFiles : files;
    for (const name of baseline) {
      await client.query('insert into schema_migrations(filename) values($1) on conflict do nothing', [name]);
      applied.add(name);
    }
  }
  const pending = files.filter(name => !applied.has(name));
  for (const name of pending) {
    await run(await fs.promises.readFile(path.join(directory, name), 'utf8'));
    await client.query('insert into schema_migrations(filename) values($1) on conflict do nothing', [name]);
  }
  return pending;
}
