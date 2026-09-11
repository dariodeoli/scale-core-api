const eligible = `o.active and m.active and m.removed_at is null and not u.is_demo_guest
 and o.demo_owner_user_id is null and o.demo_source_id is null and o.slug<>'scale-demo-controles-20260908'`;

// Match only active, real memberships. A stale preference never grants access.
export async function loginOrganization(db,{userId=null,email=null,orderByName=false}) {
 return (await db.query(`select u.id,m.organization_id,
  coalesce(p.default_organization_id=m.organization_id,false) as is_default
  from users u join organization_members m on m.user_id=u.id
  join organizations o on o.id=m.organization_id
  left join user_login_preferences p on p.user_id=u.id
  where ($1::bigint is not null and u.id=$1 or $1::bigint is null and u.email=$2) and ${eligible}
  order by is_default desc,${orderByName?'o.name,':''}m.organization_id limit 1`,[userId,email])).rows[0]||null;
}

export async function defaultOrganizationId(db,userId) {
 const row=await loginOrganization(db,{userId});
 return row?.is_default?String(row.organization_id):null;
}

export async function setDefaultOrganization(db,user,payload) {
 const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
 if(user.demo_owner_user_id||user.demo_source_id||user.organization_slug==='scale-demo-controles-20260908')fail('Elegí una empresa real para cambiar esta preferencia',403);
 if(!payload||Array.isArray(payload)||typeof payload!=='object'||Object.keys(payload).some(k=>k!=='organizationId')||!Object.hasOwn(payload,'organizationId'))fail('Indicá la empresa predeterminada');
 const value=payload.organizationId;
 if(value!==null&&(!['number','string'].includes(typeof value)||typeof value==='number'&&!Number.isSafeInteger(value)||! /^[1-9]\d{0,18}$/.test(String(value))||BigInt(value)>9223372036854775807n))fail('Empresa inválida');
 const c=await db.connect();
 try{
  await c.query('begin');
  const owner=(await c.query('select id from users where id=$1 and not is_demo_guest for update',[user.id])).rows[0];
  if(!owner)fail('Sin permiso para guardar esta preferencia',403);
  if(value!==null){
   const member=(await c.query(`select m.user_id from organization_members m join organizations o on o.id=m.organization_id join users u on u.id=m.user_id
    where m.user_id=$1 and m.organization_id=$2 and ${eligible} for share of m,o`,[user.id,value])).rows[0];
   if(!member)fail('La empresa no está disponible para tu cuenta',403);
  }
  await c.query(`insert into user_login_preferences(user_id,default_organization_id) values($1,$2)
   on conflict(user_id) do update set default_organization_id=excluded.default_organization_id,updated_at=now()`,[user.id,value]);
  await c.query('commit');return {defaultOrganizationId:value===null?null:String(value)};
 }catch(error){await c.query('rollback');throw error;}finally{c.release();}
}
