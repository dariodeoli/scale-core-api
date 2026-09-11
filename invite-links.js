import crypto from 'node:crypto';
export const accessRoles=['owner','admin','management','finance','sales','production','editor','viewer'];
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const inviteKey=crypto.createHash('sha256').update(process.env.INVITE_LINK_SECRET||process.env.GOOGLE_CLIENT_SECRET||'scale-os-invite-key').digest();
const seal=v=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',inviteKey,iv),data=Buffer.concat([cipher.update(v,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url');};
const unseal=v=>{try{const raw=Buffer.from(v,'base64url'),dec=crypto.createDecipheriv('aes-256-gcm',inviteKey,raw.subarray(0,12));dec.setAuthTag(raw.subarray(12,28));return Buffer.concat([dec.update(raw.subarray(28)),dec.final()]).toString('utf8');}catch{return null;}};
// Effective UI state only: never rewrite decisions or revoke an approved membership.
// Validity is computed by PostgreSQL's clock in each caller, not browser time.
export function accessRequestState(row){
 if(row.status!=='pending')return {status:row.status,unavailableReason:null};
 const reason=row.organization_active===false?'organization_unavailable':row.revoked_at?'revoked':row.used_at?'used':row.link_valid===false?'expired':row.existing_member?'existing_access':null;
 return {status:reason?'unavailable':'pending',unavailableReason:reason};
}
export async function resolveInvite(db,token,{countVisit=false}={}){
 if(typeof token!=='string'||!/^[-\w]{43}$/.test(token))fail('Enlace inválido o vencido',410);
 const r=(await db.query(`select l.id,l.role,l.mode,o.name as organization_name from agency_invite_links l join organizations o on o.id=l.organization_id where l.token_hash=$1 and l.revoked_at is null and l.used_at is null and l.expires_at>now() and o.active=true and o.demo_owner_user_id is null`,[hash(token)])).rows[0];
 if(r&&countVisit)await db.query('update agency_invite_links set click_count=click_count+1 where id=$1',[r.id]);
 if(!r)fail('Enlace inválido, usado, revocado o vencido',410);return r;
}
// Only called after Google verifies email AND the state cookie is checked.
export async function claimInvite(c,linkId,profile){
 if(profile.email_verified!==true)fail('Verificá tu correo con Google',403);
 const l=(await c.query(`select l.* from agency_invite_links l join organizations o on o.id=l.organization_id
 where l.id=$1 and l.revoked_at is null and l.used_at is null and l.expires_at>now() and o.active=true and o.demo_owner_user_id is null for update of l`,[linkId])).rows[0];
 if(!l)fail('Este enlace ya no está disponible',410);
 const email=String(profile.email||'').trim().toLowerCase();if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254)fail('Correo inválido');
 const u=(await c.query("insert into users(email,password_hash) values($1,'!invite-google-only') on conflict(email) do update set email=excluded.email returning id,is_demo_guest",[email])).rows[0];
 if(u.is_demo_guest)fail('Usá una cuenta de Google real',403);
 const existing=(await c.query('select active,removed_at from organization_members where organization_id=$1 and user_id=$2',[l.organization_id,u.id])).rows[0];
 // A link never changes the role or reactivates a previously removed/suspended member.
 if(existing){
  if(existing.active&&!existing.removed_at)return{userId:u.id,organizationId:l.organization_id};
  // A new invitation must be reviewable even when this email had a suspended
  // membership before. It never grants access until the owner approves it.
  const name=String(profile.name||email).slice(0,160);
  const request=(await c.query('insert into agency_access_requests(link_id,user_id,full_name) values($1,$2,$3) on conflict(link_id,user_id) do update set full_name=excluded.full_name where agency_access_requests.status=\'pending\' returning id',[l.id,u.id,name])).rows[0];
  if(!request)fail('Esta solicitud ya fue atendida. Pedí un nuevo enlace al dueño.',409);
  return{pending:true,userId:u.id,organizationId:l.organization_id};
 }
 const name=String(profile.name||email).slice(0,160);
 if(l.mode==='approval'){
  await c.query('insert into agency_access_requests(link_id,user_id,full_name) values($1,$2,$3) on conflict(link_id,user_id) do nothing',[l.id,u.id,name]);
  return{pending:true,userId:u.id,organizationId:l.organization_id};
 }
 await c.query('insert into organization_members(organization_id,user_id,role,invite_link_id) values($1,$2,$3,$4)',[l.organization_id,u.id,l.role,l.id]);
 await c.query('insert into agency_user_profiles(organization_id,user_id,full_name) values($1,$2,$3) on conflict do nothing',[l.organization_id,u.id,name]);
 await c.query('update agency_invite_links set account_count=account_count+1 where id=$1',[l.id]);
 await c.query('update agency_invite_links set used_at=now() where id=$1',[l.id]);
 return{userId:u.id,organizationId:l.organization_id};
}
export async function inviteLinks({req,res,url,db,session,body,send,appUrl}){
 const match=url.pathname.match(/^\/api\/agency\/(invite-links|access-requests)(?:\/(\d+))?$/);
 if(!match&&url.pathname!=='/api/invitations/preview')return false;
 let c;
 try{
  if(!match){if(req.method!=='GET')fail('Método no permitido',405);send(res,200,await resolveInvite(db,url.searchParams.get('token'),{countVisit:true}));return true;}
  const user=await session(req);if(!user)fail('Ingresá a tu cuenta',401);
  if(!['owner','admin'].includes(user.role))fail('Sin permiso para gestionar accesos',403);
  if(user.demo_owner_user_id)fail('El Demo no crea enlaces ni accesos externos',403);
  c=await db.connect();await c.query('begin');
  await c.query("select set_config('app.current_user',$1,true)",[String(user.id)]);
  const [ ,kind,key]=match,org=user.organization_id;let result;
  if(kind==='invite-links'&&req.method==='GET'&&!key){
   const rows=(await c.query(`select l.id,l.role,l.mode,l.created_at,l.expires_at,l.revoked_at,l.used_at,l.click_count,l.account_count,l.token_ciphertext,u.email as created_by_email,
    coalesce((select jsonb_agg(jsonb_build_object('email',j.email,'full_name',j.full_name,'joined_at',j.joined_at) order by j.joined_at) from (
     select u2.email,r.full_name,r.decided_at as joined_at from agency_access_requests r join users u2 on u2.id=r.user_id where r.link_id=l.id and r.status='approved'
     union all select u3.email,coalesce(p.full_name,u3.email),m.created_at from organization_members m join users u3 on u3.id=m.user_id left join agency_user_profiles p on p.organization_id=m.organization_id and p.user_id=m.user_id
     where m.invite_link_id=l.id and not exists(select 1 from agency_access_requests ar where ar.link_id=l.id and ar.user_id=m.user_id and ar.status='approved')
    ) j),'[]'::jsonb) as joined_users
    from agency_invite_links l join users u on u.id=l.created_by where l.organization_id=$1 order by l.id desc limit 100`,[org])).rows;
   result={links:rows.map(({token_ciphertext,...row})=>{
    const token=token_ciphertext&&(row.role!=='owner'||user.role==='owner')?unseal(token_ciphertext):null;
    return {...row,url:token?`${appUrl}/invitacion?token=${token}`:null};
   })};
  }
  else if(kind==='invite-links'&&req.method==='POST'&&!key){
   const b=await body(req);if(!accessRoles.includes(b.role)||!['single','approval'].includes(b.mode))fail('Permiso o tipo de enlace inválido');
   if(b.role==='owner'&&user.role!=='owner')fail('Solo un dueño puede invitar dueños',403);
   const token=crypto.randomBytes(32).toString('base64url');
   const link=(await c.query("insert into agency_invite_links(organization_id,token_hash,token_ciphertext,role,mode,created_by,expires_at) values($1,$2,$3,$4,$5,$6,now()+interval '7 days') returning id,expires_at",[org,hash(token),seal(token),b.role,b.mode,user.id])).rows[0];
   result={...link,url:appUrl+'/invitacion?token='+token};
  }else if(kind==='invite-links'&&key&&req.method==='DELETE'){
   const r=await c.query("update agency_invite_links set revoked_at=now() where id=$1 and organization_id=$2 and ($3='owner' or role<>'owner') returning id",[key,org,user.role]);if(!r.rows.length)fail('Enlace no encontrado o sin permiso',404);result={ok:true};
  }else if(kind==='access-requests'&&req.method==='GET'&&!key){
   const rows=(await c.query("select r.id,r.full_name,r.created_at,r.status,u.email,l.role,l.expires_at,l.revoked_at,l.used_at,l.expires_at>now() as link_valid,o.active as organization_active,exists(select 1 from organization_members m where m.organization_id=l.organization_id and m.user_id=r.user_id and m.active=true and m.removed_at is null) as existing_member from agency_access_requests r join agency_invite_links l on l.id=r.link_id join organizations o on o.id=l.organization_id join users u on u.id=r.user_id where l.organization_id=$1 and r.status='pending' order by r.created_at limit 100",[org])).rows;
   result={requests:rows.map(({link_valid,organization_active,existing_member,...row})=>({...row,...accessRequestState({...row,link_valid,organization_active,existing_member})}))};
  }else if(kind==='access-requests'&&key&&req.method==='PATCH'){
   const b=await body(req);if(!['approve','reject'].includes(b.action))fail('Acción inválida');
   // Same lock as link claiming/revocation. Concurrent approvals are idempotent.
   const r=(await c.query('select r.*,l.organization_id,l.role,l.revoked_at,l.used_at,l.expires_at>now() as link_valid,o.active as organization_active from agency_access_requests r join agency_invite_links l on l.id=r.link_id join organizations o on o.id=l.organization_id where r.id=$1 and l.organization_id=$2 for update of l,r',[key,org])).rows[0];
   if(!r)fail('Solicitud no encontrada',404);if(r.status!=='pending')fail('La solicitud ya fue atendida',409);
   if(r.role==='owner'&&user.role!=='owner')fail('Solo un dueño puede aprobar otro dueño',403);
   if(String(r.user_id)===String(user.id))fail('No podés aprobar tu propia solicitud',403);
   if(b.action==='approve'){
    if(accessRequestState(r).status==='unavailable')fail('La invitación ya no está disponible. Revisá la empresa y generá otro enlace.',409);
    const old=(await c.query('select user_id,active,removed_at from organization_members where user_id=$1 and organization_id=$2 for update',[r.user_id,org])).rows[0];
    if(old?.active&&!old.removed_at)fail('Esta persona ya tiene acceso. Gestioná su permiso desde Equipo.',409);
    if(old)await c.query('update organization_members set role=$1,active=true,removed_at=null,invite_link_id=$4 where organization_id=$2 and user_id=$3',[r.role,org,r.user_id,r.link_id]);
    else await c.query('insert into organization_members(organization_id,user_id,role,invite_link_id) values($1,$2,$3,$4)',[org,r.user_id,r.role,r.link_id]);
    await c.query('insert into agency_user_profiles(organization_id,user_id,full_name) values($1,$2,$3) on conflict do nothing',[org,r.user_id,r.full_name]);
    await c.query('update agency_invite_links set account_count=account_count+1,used_at=case when mode=\'single\' then now() else used_at end where id=$1',[r.link_id]);
   }
   await c.query('update agency_access_requests set status=$1,decided_at=now(),decided_by=$2 where id=$3',[b.action==='approve'?'approved':'rejected',user.id,key]);result={ok:true};
  }else fail('Método no permitido',405);
  await c.query('commit');send(res,200,result);return true;
 }catch(e){if(c)await c.query('rollback');send(res,e.status||500,{error:e.status?e.message:'No se pudo gestionar la invitación'});return true;}finally{c?.release();}
}
