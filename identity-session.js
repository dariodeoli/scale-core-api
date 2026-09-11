// Internal authentication helper, not an employee/admin editing API.
// userId must come from verified authentication; orgId is the selected real
// organization. Missing/inactive membership, pending applicants and demos skip.
function identifier(value){
 if(typeof value==='number'&&!Number.isSafeInteger(value))throw new TypeError('Invalid identity id');
 if(!['string','number','bigint'].includes(typeof value)||!/^\d{1,19}$/.test(String(value)))throw new TypeError('Invalid identity id');
 const id=BigInt(value);if(id<1n||id>9223372036854775807n)throw new TypeError('Invalid identity id');
 return String(id);
}

// c must already be inside a transaction. The caller commits/rolls back.
// Returns {full_name,photo_url}, or null when ineligible. Existing identity wins.
export async function ensurePersonalIdentityInTransaction(c,userId,orgId){
 const user=identifier(userId),org=identifier(orgId);
 const eligible=(await c.query(`select u.id from users u
  join organization_members m on m.user_id=u.id join organizations o on o.id=m.organization_id
  where u.id=$1 and m.organization_id=$2 and not u.is_demo_guest
   and m.active and m.removed_at is null and o.active
   and o.demo_owner_user_id is null and o.demo_source_id is null and o.slug<>'scale-demo-controles-20260908'
  for update of u for share of m,o`,[user,org])).rows[0];
 if(!eligible)return null;
 // Match the profile endpoint's user lock, including first-insert races.
 const prior=(await c.query("select current_setting('app.current_user',true) as actor,current_setting('app.current_organization',true) as organization")).rows[0];
 await c.query("select set_config('app.current_user',$1,true),set_config('app.current_organization',$2,true)",[user,org]);
 await c.query(`insert into user_personal_identities(user_id,full_name,photo_url,updated_at)
  select u.id,coalesce(nullif(p.full_name,u.email),nullif(to_jsonb(u)->>'google_full_name',''),p.full_name,left(trim(u.email),120)),coalesce(nullif(p.photo_url,''),to_jsonb(u)->>'google_photo_url'),coalesce(p.updated_at,now())
  from users u
  left join lateral (
   select trim(p.full_name) as full_name,p.photo_url,p.updated_at
   from agency_user_profiles p join organization_person_identity i
    on i.user_id=p.user_id and i.organization_id=p.organization_id
   where p.user_id=u.id and not i.is_demo and length(trim(p.full_name)) between 2 and 120
   order by p.updated_at desc,p.organization_id asc limit 1
  ) p on true
  where u.id=$1 and exists(select 1 from organization_person_identity i
   where i.user_id=u.id and i.organization_id=$2 and not i.is_demo)
   and length(coalesce(p.full_name,left(trim(u.email),120))) between 2 and 120
  on conflict(user_id) do nothing returning user_id`,[user,org]);
 // Fill only an absent photo, under the same owner lock. Never replace a chosen photo.
 await c.query(`update user_personal_identities g set photo_url=to_jsonb(u)->>'google_photo_url',updated_at=now()
  from users u where g.user_id=$1 and u.id=g.user_id and nullif(g.photo_url,'') is null
  and nullif(to_jsonb(u)->>'google_photo_url','') is not null`,[user]);
 await c.query(`update user_personal_identities g set full_name=to_jsonb(u)->>'google_full_name',updated_at=now()
  from users u where g.user_id=$1 and u.id=g.user_id and (g.full_name=u.email or nullif(trim(g.full_name),'') is null)
  and length(to_jsonb(u)->>'google_full_name') between 2 and 120`,[user]);
 // Do not change the enclosing login/switch transaction's audit identity.
 // On a SQL error the caller must roll back, so no query runs in an aborted tx.
 await c.query("select set_config('app.current_user',$1,true),set_config('app.current_organization',$2,true)",[prior.actor||'',prior.organization||'']);
 return (await c.query(`select g.full_name,g.photo_url from user_personal_identities g
  join organization_person_identity i on i.user_id=g.user_id
  where g.user_id=$1 and i.organization_id=$2 and not i.is_demo`,[user,org])).rows[0]||null;
}

// Pool/db wrapper: owns BEGIN/COMMIT and always releases its connection.
export async function ensurePersonalIdentity(db,userId,orgId){
 const c=await db.connect();
 try{
  await c.query('begin');
  const identity=await ensurePersonalIdentityInTransaction(c,userId,orgId);
  await c.query('commit');return identity;
 }catch(error){await c.query('rollback');throw error;}
 finally{c.release();}
}
