import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

// Contact details never grant administrative permissions or overwrite an existing role.
export async function collaboratorAccess(c, { email, org, actorRole, active, previousUserId }) {
  if (!email) return { userId: previousUserId || null, status: 'no_email' };
  if (!active) return { userId: previousUserId || null, status: 'inactive' };
  if (!['owner', 'admin'].includes(actorRole)) return { userId: previousUserId || null, status: 'needs_admin' };
  let account = (await c.query('select id from users where email=$1', [email])).rows[0];
  if (!account) {
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    account = (await c.query("insert into users(email,password_hash,role) values($1,$2,'viewer') on conflict(email) do update set email=excluded.email returning id", [email, hash])).rows[0];
  }
  const membership = await c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer') on conflict(organization_id,user_id) do nothing returning user_id", [org, account.id]);
  const current=(await c.query('select active from organization_members where organization_id=$1 and user_id=$2',[org,account.id])).rows[0];
  if(current.active===false)return {userId:account.id,status:'suspended'};
  return { userId: account.id, status: membership.rows.length ? 'invited' : 'linked', notifyEmail: membership.rows.length ? email : null };
}
