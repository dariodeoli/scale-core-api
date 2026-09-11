import fs from 'node:fs/promises';

// Older handler fixtures predate the identity view now used by their responses.
// Install the actual production migrations, not a permissive test-only view.
export async function identitySchema(pg) {
 for (const name of ['20260908_google_oauth','20260910_productivity','20260910_profile_identity',
  '20260910_demo_sessions','20260910_invite_links','20260910_global_identity','20260911_demo_owner_identity']) {
  await pg.exec(await fs.readFile(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8'));
 }
}
