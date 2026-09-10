import pg from 'pg';
import {runMaintenance, startMaintenance} from '../maintenance.js';

const args = process.argv.slice(2);
if (args.length !== 1 || !['--dry-run', '--apply', '--schedule'].includes(args[0])) {
 console.error('Usage: node scripts/cleanup-expired-demo.mjs --dry-run|--apply|--schedule');
 process.exitCode = 1;
} else if (!process.env.DATABASE_URL) {
 console.error(JSON.stringify({event: 'maintenance_config_missing', missing: ['DATABASE_URL']}));
 process.exitCode = 1;
} else {
 const db = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000});
 if (args[0] === '--schedule') {
  try {
   const stop = startMaintenance(db, {env: {...process.env, MAINTENANCE_ENABLED: 'true'},
    timers: {setInterval: (fn, ms) => ({handle: setInterval(fn, ms)}), clearInterval: t => clearInterval(t.handle)}});
   for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop(); void db.end(); });
  } catch { console.error(JSON.stringify({event: 'maintenance_config_invalid'})); process.exitCode = 1; await db.end(); }
 } else {
  try {
   const result = await runMaintenance(db, {dryRun: args[0] !== '--apply'});
   console.log(JSON.stringify(result));
   if (result.demos?.some(d => d.status === 'blocked')) process.exitCode = 1;
  }
  catch { console.error(JSON.stringify({event: 'maintenance_failed'})); process.exitCode = 1; }
  finally { await db.end(); }
 }
}
