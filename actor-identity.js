// Display attribution only. Call after the handler has authorized and scoped rows.
// Resolve explicit user IDs through the same tenant-scoped view as presence and
// history; never match names/emails or use an importer's ID as the source author.
// Removed members deliberately lose verified display identity, as in history.
export async function attributeActors(c, organizationId, groups) {
 const targets = groups.flatMap(({rows = [], userId, prefix = 'actor', fallback = []}) =>
  (Array.isArray(rows) ? rows : [rows]).filter(Boolean).map(row => ({row, userId, prefix, fallback})));
 if (!targets.length) return;
 const validId = value => /^(?:[1-9]\d{0,18})$/.test(String(value)) && BigInt(value) <= 9223372036854775807n;
 const ids = [...new Set(targets.map(t => t.row[t.userId]).filter(validId).map(String))];
 const identities = ids.length ? (await c.query(
  'select user_id,full_name,photo_url,email from organization_person_identity where organization_id=$1 and user_id=any($2::bigint[])',
  [organizationId, ids])).rows : [];
 const byId = new Map(identities.map(i => [String(i.user_id), i]));
 for (const {row, userId, prefix, fallback} of targets) {
  const identity = byId.get(String(row[userId]));
  const previousName = fallback.map(key => row[key]).find(value => typeof value === 'string' && value.trim());
  row[`${prefix}_name`] = identity?.full_name?.trim() || identity?.email || previousName || (row[userId] == null ? null : 'Usuario');
  row[`${prefix}_photo_url`] = identity?.photo_url || null;
  row[`${prefix}_user_id`] = identity?.user_id ?? null;
  row[`${prefix}_verified`] = Boolean(identity);
 }
}
