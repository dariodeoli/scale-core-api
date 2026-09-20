import crypto from 'node:crypto';
import {inspectInternalSubscription,updateInternalSubscription,realOrganization} from './platform-subscription-service.js';
import {optionalUpdate,createPlatformPreview,consumePlatformDeletionProof} from './account-security.js';

const currencies=['USD','PYG'];
const realUser=alias=>`not ${alias}.is_demo_guest and ${alias}.deleted_at is null and ${alias}.email not ilike '%@demo.example.invalid' and ${alias}.email not ilike '%@scale-demo.example.invalid'`;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
// `Number.isInteger(1e21)` es true pero Postgres no acepta ese bigint: se exige safe integer.
const integer=(value,fallback=0)=>{if(value===null||value===undefined||value==='')return fallback;const parsed=Number(value);return Number.isSafeInteger(parsed)&&parsed>=0?parsed:fallback;};
const limit=value=>Math.min(100,Math.max(1,integer(value,25)));
// Los ids de ruta se validan como bigint antes de tocar la base (un dígito de más era un 500).
const routeId=value=>{const raw=String(value);if(!/^[1-9]\d{0,18}$/.test(raw)||BigInt(raw)>9223372036854775807n)fail('Agencia no encontrada o protegida.',404);return Number(raw);};
const queryText=value=>typeof value==='string'?value.trim().slice(0,120):'';
const couponCode=value=>{
 const code=queryText(value).toUpperCase();
 if(!/^[A-Z0-9_-]{3,40}$/.test(code))fail('El código debe tener entre 3 y 40 caracteres: letras, números, guion o guion bajo.');
 return code;
};
const couponType=value=>{if(!['percent','fixed','days'].includes(value))fail('Tipo de descuento inválido.');return value;};
const couponValue=value=>{const amount=Number(value);if(!Number.isFinite(amount)||amount<=0||amount>1000000000)fail('Valor de descuento inválido.');return amount;};
const couponCurrency=value=>{if(value===null||value===undefined||value==='')return null;if(!currencies.includes(value))fail('Moneda de cupón inválida.');return value;};
const couponLifetime=value=>{if(value===undefined)return false;if(typeof value!=='boolean')fail('La elegibilidad vitalicia debe ser booleana.');return value;};
const object=value=>{if(!value||typeof value!=='object'||Array.isArray(value))fail('Solicitud inválida.');return value;};
const only=(value,keys)=>{if(Object.keys(value).some(key=>!keys.includes(key)))fail('La solicitud contiene campos no permitidos.');return value;};
async function actor(db,session,req){
 const user=await session(req);if(!user)fail('No autenticado',401);
 if(user.demo_owner_user_id||user.demo_source_id)fail('El Demo no accede a la administración global.',403);
 const membership=(await db.query('select role from platform_administrators where user_id=$1 and active=true',[user.id])).rows[0];
 if(!membership)fail('No tenés acceso a la administración global.',403);
 return {user,role:membership.role};
}
const requireWrite=role=>{if(role!=='admin')fail('Solo un administrador global puede hacer cambios.',403);};
async function audit(db,user,action,targetType,targetId,metadata={}){
 await db.query('insert into platform_audit_log(actor_user_id,action,target_type,target_id,metadata) values($1,$2,$3,$4,$5::jsonb)',[user.id,action,targetType,String(targetId),JSON.stringify(metadata)]);
}
async function mutation(db,work){
 if(typeof db.connect!=='function')return work(db);
 const client=await db.connect();try{await client.query('begin');const result=await work(client);await client.query('commit');return result;}catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
// Reintento seguro: la misma Idempotency-Key (header o cuerpo) identifica la misma
// operación. Sin clave el contrato queda igual que antes de este endurecimiento.
function idempotencyKey(input,req){
 const raw=(req.headers||{})['idempotency-key']??input?.idempotencyKey;
 if(raw===undefined||raw===null||raw==='')return null;
 const key=String(raw).trim();
 if(!/^[A-Za-z0-9._:-]{8,120}$/.test(key))fail('La clave de idempotencia debe tener entre 8 y 120 caracteres (letras, números, . _ : -).');
 return key;
}
function page(url){return {limit:limit(url.searchParams.get('limit')),offset:integer(url.searchParams.get('offset'))};}
function search(url){return (url.searchParams.get('q')||'').trim().slice(0,100);}
function couponConfiguration(input,current=null){
 const incoming=only(object(input),['code','discount_type','discount_value','currency','max_redemptions','lifetime_eligible','active']);
 const type=incoming.discount_type===undefined?current?.discount_type:couponType(incoming.discount_type);
 const value=incoming.discount_value===undefined?Number(current?.discount_value):couponValue(incoming.discount_value);
 const currency=incoming.currency===undefined?current?.currency:couponCurrency(incoming.currency);
 const active=incoming.active===undefined?(current?.active??true):incoming.active;
 const lifetime=incoming.lifetime_eligible===undefined?(current?.lifetime_eligible??false):couponLifetime(incoming.lifetime_eligible);
 const max=incoming.max_redemptions===undefined?current?.max_redemptions:incoming.max_redemptions===null||incoming.max_redemptions===''?null:integer(incoming.max_redemptions,-1);
 if(!type||typeof active!=='boolean'||(type==='percent'&&currency!==null)||(type==='fixed'&&currency===null)||(type==='days'&&currency!==null)||(type==='percent'&&value>100)||(type==='days'&&(!Number.isInteger(value)||value>3650)))fail('La configuración del cupón no es válida.');
 if(max!==null&&max<1)fail('El máximo de usos debe ser un entero positivo.');
 return {type,value,currency,active,lifetime,max,code:incoming.code===undefined?current?.code:couponCode(incoming.code)};
}
export async function platformAdmin({req,res,url,db,session,body,send,bootstrapValue=''}){
 if(!url.pathname.startsWith('/api/platform/'))return false;
 try{
  if(url.pathname==='/api/platform/bootstrap-status'&&req.method==='GET'){send(res,200,await platformBootstrapStatus(db,bootstrapValue));return true;}
  const {user,role}=await actor(db,session,req);
  if(url.pathname==='/api/platform/overview'&&req.method==='GET'){
   const [agencies,users,subscriptions,coupons]=(await Promise.all([
    db.query(`select count(*)::int as total,count(*) filter(where active)::int as active from organizations where ${realOrganization('organizations')}`),
    db.query(`select count(*)::int as total from users where ${realUser('users')}`),
    db.query(`select s.stripe_status as status,count(*)::int as total from organization_subscriptions s join organizations o on o.id=s.organization_id where ${realOrganization('o')} group by s.stripe_status order by s.stripe_status`),
    db.query('select count(*)::int as total,count(*) filter(where active)::int as active from platform_coupons')
   ])).map(result=>result.rows);
   send(res,200,{agencies:agencies[0],users:users[0],subscriptions,coupons:coupons[0]});return true;
  }
  if(url.pathname==='/api/platform/agencies'&&req.method==='GET'){
   const {limit,offset}=page(url),q=search(url),where=q?'and (o.name ilike $3 or o.slug ilike $3)':'';
   const values=q?[limit,offset,'%'+q+'%']:[limit,offset];
   const result=await db.query(`select o.id,o.name,o.slug,o.active,o.created_at,
     s.stripe_status as subscription_status,s.currency as subscription_currency,
     case s.currency when 'USD' then 10::numeric when 'PYG' then 50000::numeric else null end as subscription_amount,
     s.trial_ends_at,s.due_at,ps.state as internal_subscription_state,ps.expires_at as internal_subscription_expires_at,
     count(m.user_id) filter(where m.active and m.removed_at is null and ${realUser('u')})::int as active_users
     from organizations o left join organization_subscriptions s on s.organization_id=o.id
     left join platform_subscription_states ps on ps.organization_id=o.id
     left join organization_members m on m.organization_id=o.id
     left join users u on u.id=m.user_id
     where ${realOrganization('o')} ${where}
     group by o.id,s.stripe_status,s.currency,s.trial_ends_at,s.due_at,ps.state,ps.expires_at order by o.created_at desc limit $1 offset $2`,values);
   send(res,200,{agencies:result.rows,limit,offset});return true;
  }
  const subscriptionPath=url.pathname.match(/^\/api\/platform\/agencies\/(\d+)\/subscription$/);
  if(subscriptionPath&&req.method==='GET'){send(res,200,await inspectInternalSubscription(db,subscriptionPath[1]));return true;}
  const extendPath=url.pathname.match(/^\/api\/platform\/agencies\/(\d+)\/subscription\/extend$/);
  if(extendPath&&req.method==='POST'){
   requireWrite(role);
   const input=await body(req),days=integer(input?.days??0,-1);
   if(days<1||days>3650)fail('Los días deben ser un entero entre 1 y 3650.');
   const reasonText=queryText(input?.reason||'');if(reasonText.length<3)fail('Indicá un motivo de al menos 3 caracteres.');
   const idempotency=idempotencyKey(input,req);
   const result=await mutation(db,async client=>{
    const id=Number(extendPath[1]);
    const org=(await client.query(`select o.id,o.name,coalesce((select s.default_currency from agency_settings s where s.organization_id=o.id),'PYG') as default_currency from organizations o where o.id=$1 and ${realOrganization('o')} for update`,[id])).rows[0];
    if(!org)fail('Agencia no encontrada o protegida.',404);
    // Manual payments work even before any trial: open the runway row first,
    // con la moneda de la empresa (antes quedaba fija en USD).
    await client.query(`insert into organization_subscriptions(organization_id,currency,binding_token) values($1,$2,$3) on conflict(organization_id) do nothing`,[id,org.default_currency,crypto.randomUUID()]);
    const sub=(await client.query('select due_at,paid_through_at from organization_subscriptions where organization_id=$1 for update',[id])).rows[0];
    // La clave se busca después de tomar el lock: un reintento (o una carrera)
    // devuelve el estado actual sin volver a sumar días.
    if(idempotency&&(await client.query(`select 1 from platform_audit_log where actor_user_id=$1 and action='subscription.manual_extend' and metadata->>'idempotencyKey'=$2 limit 1`,[user.id,idempotency])).rows.length){
     return {...await inspectInternalSubscription(client,id),idempotent_replay:true};
    }
    const base=new Date(Math.max(Date.now(),sub.paid_through_at?new Date(sub.paid_through_at).getTime():new Date(sub.due_at).getTime()));
    base.setDate(base.getDate()+days);
    const due=new Date(Math.max(base.getTime(),new Date(sub.due_at).getTime()));
    await client.query('update organization_subscriptions set paid_through_at=$2,due_at=$3,updated_at=now() where organization_id=$1',[id,base.toISOString(),due.toISOString()]);
    const internal=(await client.query('select expires_at from platform_subscription_states where organization_id=$1 for update',[id])).rows[0];
    const internalBase=new Date(Math.max(Date.now(),internal?.expires_at?new Date(internal.expires_at).getTime():Date.now()));
    internalBase.setDate(internalBase.getDate()+days);
    await client.query(`insert into platform_subscription_states(organization_id,state,reason,expires_at,updated_by_user_id)
     values($1,'active',$2,$3,$4) on conflict(organization_id) do update set state='active',reason=excluded.reason,expires_at=excluded.expires_at,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()`,[id,reasonText,internalBase.toISOString(),user.id]);
    await audit(client,user,'subscription.manual_extend','organization_subscription',id,{days,reason:reasonText,...(idempotency?{idempotencyKey:idempotency}:{})});
    return inspectInternalSubscription(client,id);
   });
   send(res,200,result);return true;
  }
  if(subscriptionPath&&req.method==='PATCH'){
   requireWrite(role);
   const result=await mutation(db,async client=>{
    const change=await updateInternalSubscription(client,subscriptionPath[1],await body(req),user.id);
    await audit(client,user,change.change.state===null?'subscription.internal_state.clear':'subscription.internal_state.update','organization_subscription',subscriptionPath[1],{state:change.change.state,expires_at:change.change.expiresAt});
    return change.view;
   });
   send(res,200,result);return true;
  }
  // Borrados globales (issue #22): vista previa + prueba de re-autenticación.
  if(url.pathname==='/api/platform/destructive/preview'&&req.method==='POST'){
   requireWrite(role);
   const input=await body(req),action=input?.action,targetId=integer(input?.targetId);
   if(!['platform.user.delete','platform.agency.delete'].includes(action))fail('Operación de borrado inválida.');
   const preview=await createPlatformPreview(db,{userId:user.id,action,organizationId:action==='platform.agency.delete'?targetId:null,targetId});
   send(res,200,{preview});return true;
  }
  const agencyPath=url.pathname.match(/^\/api\/platform\/agencies\/(\d+)$/);
  if(agencyPath&&req.method==='DELETE'){
   requireWrite(role);
   const input=await body(req);
   const deleted=await mutation(db,async client=>{
    const target=(await client.query(`select o.id,o.name,o.slug from organizations o where o.id=$1 and ${realOrganization('o')} for update`,[routeId(agencyPath[1])])).rows[0];
    if(!target)fail('Agencia no encontrada o protegida.',404);
    await consumePlatformDeletionProof(client,{userId:user.id,previewId:input?.previewId,confirmation:input?.confirmation,recentAuthProof:input?.recentAuthProof,action:'platform.agency.delete',organizationId:target.id});
    await client.query('update organizations set active=false,deleted_at=now(),deleted_by_user_id=$2 where id=$1',[target.id,user.id]);
    await client.query('delete from sessions where organization_id=$1',[target.id]);
    await audit(client,user,'agency.delete','organization',target.id,{name:target.name,slug:target.slug});
    return {agencyId:target.id,name:target.name,slug:target.slug};
   });
   send(res,200,{deleted});return true;
  }
  if(url.pathname==='/api/platform/users'&&req.method==='GET'){
   const {limit,offset}=page(url),q=search(url),where=q?'and u.email ilike $3':'';
   const values=q?[limit,offset,'%'+q+'%']:[limit,offset];
   const result=await db.query(`select u.id,u.email,u.created_at,
     count(m.organization_id) filter(where m.active and m.removed_at is null and ${realOrganization('o')})::int as active_agencies,
     exists(select 1 from platform_administrators pa where pa.user_id=u.id and pa.active) as platform_admin,
     (select pa.role from platform_administrators pa where pa.user_id=u.id and pa.active) as platform_role
     from users u left join organization_members m on m.user_id=u.id
     left join organizations o on o.id=m.organization_id
     where ${realUser('u')} ${where}
     group by u.id order by u.created_at desc limit $1 offset $2`,values);
   send(res,200,{users:result.rows,limit,offset});return true;
  }
  if(url.pathname==='/api/platform/coupons'&&req.method==='GET'){
   const {limit,offset}=page(url),q=search(url),where=q?'where c.code ilike $3':'';
   const values=q?[limit,offset,'%'+q+'%']:[limit,offset];
   const result=await db.query(`select c.id,c.code,c.discount_type,c.discount_value,c.currency,c.active,c.max_redemptions,c.lifetime_eligible,c.created_at,c.updated_at,u.email as created_by
     from platform_coupons c join users u on u.id=c.created_by_user_id ${where} order by c.created_at desc limit $1 offset $2`,values);
   send(res,200,{coupons:result.rows,limit,offset});return true;
  }
  if(url.pathname==='/api/platform/coupons'&&req.method==='POST'){
   requireWrite(role);
   const input=couponConfiguration(await body(req));if(!input.code)fail('El código del cupón es obligatorio.');
   const coupon=await mutation(db,async client=>{
    const result=await client.query('insert into platform_coupons(code,discount_type,discount_value,currency,max_redemptions,lifetime_eligible,created_by_user_id) values($1,$2,$3,$4,$5,$6,$7) returning id,code,discount_type,discount_value,currency,active,max_redemptions,lifetime_eligible,created_at,updated_at',[input.code,input.type,input.value,input.currency,input.max,input.lifetime,user.id]);
    await audit(client,user,'coupon.create','coupon',result.rows[0].id,{lifetime_eligible:input.lifetime});return result.rows[0];
   });
   send(res,201,{coupon});return true;
  }
  const couponPath=url.pathname.match(/^\/api\/platform\/coupons\/(\d+)$/);
  if(couponPath&&req.method==='PATCH'){
   requireWrite(role);
   const coupon=await mutation(db,async client=>{
    const id=Number(couponPath[1]),current=(await client.query('select * from platform_coupons where id=$1 for update',[id])).rows[0];if(!current)fail('Cupón no encontrado',404);
    const input=couponConfiguration(await body(req),current);
    const result=await client.query('update platform_coupons set discount_type=$1,discount_value=$2,currency=$3,active=$4,max_redemptions=$5,lifetime_eligible=$6,updated_at=now() where id=$7 returning id,code,discount_type,discount_value,currency,active,max_redemptions,lifetime_eligible,created_at,updated_at',[input.type,input.value,input.currency,input.active,input.max,input.lifetime,id]);
    await audit(client,user,current.active&&!input.active?'coupon.deactivate':'coupon.update','coupon',id,{lifetime_eligible:input.lifetime,active:input.active});return result.rows[0];
   });
   send(res,200,{coupon});return true;
  }
  const userPath=url.pathname.match(/^\/api\/platform\/users\/(\d+)$/);
  if(userPath&&req.method==='PATCH'){
   requireWrite(role);
   const targetId=Number(userPath[1]);
   if(targetId===user.id)fail('No podés cambiar tu propio acceso global.',400);
   const input=only((await body(req))||{},['platform_access']);
   if(!['admin','viewer','none'].includes(input.platform_access))fail('El acceso global debe ser admin, viewer o none.');
   const access=await mutation(db,async client=>{
    const target=(await client.query(`select id from users where id=$1 and ${realUser('users')}`,[targetId])).rows[0];
    if(!target)fail('Usuario no encontrado.',404);
    if(input.platform_access==='none'){
     const revoked=(await client.query('update platform_administrators set active=false where user_id=$1 returning user_id',[targetId])).rows[0];
     if(revoked)await audit(client,user,'platform_access.revoke','platform_administrator',targetId,{role:'none'});
     return {platform_access:'none',changed:Boolean(revoked)};
    }
    const row=(await client.query(`insert into platform_administrators(user_id,role,active,created_by_user_id) values($1,$2,true,$3) on conflict(user_id) do update set role=excluded.role,active=true,created_by_user_id=excluded.created_by_user_id returning user_id,role`,[targetId,input.platform_access,user.id])).rows[0];
    await audit(client,user,'platform_access.grant','platform_administrator',targetId,{role:input.platform_access});
    return {platform_access:input.platform_access,changed:true};
   });
   send(res,200,{access});return true;
  }
  if(userPath&&req.method==='DELETE'){
   requireWrite(role);
   const input=await body(req);
   const targetId=Number(userPath[1]),self=targetId===user.id;
   const deleted=await mutation(db,async client=>{
    const target=(await client.query(`select id from users where id=$1 and ${realUser('users')} for update`,[targetId])).rows[0];
    if(!target)fail('Usuario no encontrado.',404);
    await consumePlatformDeletionProof(client,{userId:user.id,previewId:input?.previewId,confirmation:input?.confirmation,recentAuthProof:input?.recentAuthProof,action:'platform.user.delete',organizationId:null});
    if(!self){
     const adminRow=(await client.query("select 1 from platform_administrators where user_id=$1 and active=true and role='admin'",[targetId])).rows[0];
     if(adminRow)fail('No podés eliminar a otro administrador global.',403);
    }
    const owned=(await client.query(`select o.id from organizations o join organization_members m on m.organization_id=o.id where m.user_id=$1 and m.role='owner' and m.active and m.removed_at is null and ${realOrganization('o')}`,[targetId])).rows;
    for(const org of owned){
     await client.query('update organizations set active=false,deleted_at=now(),deleted_by_user_id=$2 where id=$1',[org.id,user.id]);
     await client.query('delete from sessions where organization_id=$1',[org.id]);
    }
    await client.query('delete from sessions where user_id=$1',[targetId]);
    await client.query('delete from oauth_states where recent_auth_user_id=$1',[targetId]);
    // Children of destructive_action_previews reference it ON DELETE RESTRICT;
    // remove them before the previews themselves.
    await client.query('delete from destructive_email_challenges where user_id=$1',[targetId]);
    await client.query('delete from destructive_google_handoffs where user_id=$1',[targetId]);
    await client.query('delete from destructive_auth_proofs where user_id=$1',[targetId]);
    await client.query('delete from destructive_action_previews where user_id=$1',[targetId]);
    await client.query('delete from platform_administrators where user_id=$1',[targetId]);
    // Memberships are soft-removed so inventory/studio/verification rows that
    // reference (organization_id,user_id) keep their foreign keys and history.
    await client.query('update organization_members set active=false,removed_at=now() where user_id=$1',[targetId]);
    const anonymous=`deleted+${targetId}+${crypto.randomBytes(8).toString('hex')}@deleted.invalid`;
    await optionalUpdate(client,'user_personal_identities',"update user_personal_identities set full_name='Deleted account',photo_url=null,updated_at=now() where user_id=$1",[targetId]);
    await optionalUpdate(client,'agency_user_profiles',"update agency_user_profiles set full_name='Deleted account',photo_url=null,updated_at=now() where user_id=$1",[targetId]);
    await optionalUpdate(client,'agency_collaborators',"update agency_collaborators set full_name='Deleted account',email=null,photo_url=null,updated_at=now() where user_id=$1",[targetId]);
    await optionalUpdate(client,'agency_access_requests',"update agency_access_requests set full_name='Deleted account' where user_id=$1",[targetId]);
    await optionalUpdate(client,'oauth_handoffs','delete from oauth_handoffs where user_id=$1',[targetId]);
    await optionalUpdate(client,'account_closure_requests','update account_closure_requests set cancelled_at=coalesce(cancelled_at,now()) where user_id=$1',[targetId]);
    await client.query("update users set email=$2,password_hash='!deleted-account',google_photo_url=null,google_full_name=null,deleted_at=now(),anonymized_at=now() where id=$1",[targetId,anonymous]);
    await audit(client,user,'user.delete','user',targetId,{self,agencies:owned.map(org=>org.id)});
    return {userId:targetId,self,agencies:owned.map(org=>org.id)};
   });
   send(res,200,{deleted});return true;
  }
  if(url.pathname==='/api/platform/audit'&&req.method==='GET'){
   const {limit,offset}=page(url),q=search(url),where=q?'where action ilike $3 or target_type ilike $3 or target_id ilike $3 or actor_email ilike $3':'';
   const values=q?[limit,offset,'%'+q+'%']:[limit,offset];
   const result=await db.query(`select * from (
     select a.id,a.action,a.target_type,a.target_id,a.metadata,a.created_at,u.email as actor_email
     from platform_audit_log a join users u on u.id=a.actor_user_id
     union all
     select b.id,b.action,'platform_administrator'::text,b.target_user_id::text,'{}'::jsonb,b.created_at,null::text
     from platform_bootstrap_audit_log b
    ) actions ${where} order by created_at desc,id desc limit $1 offset $2`,values);
   send(res,200,{actions:result.rows,limit,offset});return true;
  }
  fail('Ruta de administración global no encontrada.',404);
  }catch(error){if(process.env.PLATFORM_ADMIN_DEBUG&&!error.status)console.error('PLATFORM 500:',error.message,error.detail||'',error.constraint||'');send(res,error.status||500,{error:error.status?error.message:'No se pudo completar la operación global.'});return true;}
}
export function platformBootstrapEmail(value){
 const email=String(value||'').trim().toLowerCase();
 return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.length<=254?email:null;
}
export async function platformBootstrapStatus(db,value){
 const configured=String(value||'').trim().length>0,valid=Boolean(platformBootstrapEmail(value));
 const initialized=(await db.query('select exists(select 1 from platform_administrators) as initialized')).rows[0]?.initialized===true;
 return {configured,valid,initialized,state:initialized?'initialized':!configured?'not_configured':!valid?'invalid_configuration':'awaiting_eligible_user'};
}
export async function bootstrapInitialPlatformAdmin(db,value){
 const email=platformBootstrapEmail(value),status=await platformBootstrapStatus(db,value);
 if(status.initialized||!email)return {...status,activated:false};
 const target=(await db.query(`select u.id from users u where u.email=$1 and u.email_verified_at is not null and u.is_demo_guest=false
   and exists(select 1 from organization_members m where m.user_id=u.id and m.active=true and m.removed_at is null) limit 1`,[email])).rows[0];
 if(!target)return {...status,activated:false,state:'awaiting_eligible_user'};
 const created=await db.query(`insert into platform_administrators(user_id,created_by_user_id) select $1,null where not exists(select 1 from platform_administrators)
   on conflict(user_id) do nothing returning user_id`,[target.id]);
 if(!created.rows[0])return {...await platformBootstrapStatus(db,value),activated:false};
 await db.query("insert into platform_bootstrap_audit_log(target_user_id,action) values($1,'initial_admin_granted') on conflict(target_user_id,action) do nothing",[target.id]);
 return {...await platformBootstrapStatus(db,value),activated:true,state:'activated'};
}
// The configured owner email is always an active global admin, even after the
// platform was initialized. Idempotent and audited: it repairs a lockout where
// no admin can grant access, without weakening the write gating.
export async function ensurePlatformOwnerAdmin(db,value){
 const email=platformBootstrapEmail(value);
 if(!email)return false;
 const target=(await db.query(`select u.id from users u where u.email=$1 and u.email_verified_at is not null and u.is_demo_guest=false
   and exists(select 1 from organization_members m where m.user_id=u.id and m.active=true and m.removed_at is null) limit 1`,[email])).rows[0];
 if(!target)return false;
 const granted=await db.query(`insert into platform_administrators(user_id,role,active,created_by_user_id) values($1,'admin',true,null)
   on conflict(user_id) do update set role='admin',active=true where platform_administrators.role<>'admin' or platform_administrators.active=false returning user_id`,[target.id]);
 if(!granted.rows.length)return false;
 await db.query("insert into platform_bootstrap_audit_log(target_user_id,action) values($1,'owner_admin_ensured') on conflict(target_user_id,action) do nothing",[target.id]);
 return true;
}
