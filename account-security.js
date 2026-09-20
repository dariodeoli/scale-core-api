import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const CLOSE_CONFIRMATION='CERRAR MI CUENTA';
const DELETE_ACCOUNT_CONFIRMATION='Eliminar';
const RECOVERY_DAYS=30;
const PREVIEW_MINUTES=5;
const PROOF_MINUTES=5;
const EMAIL_CODE_MINUTES=5;
const EMAIL_CODE_DIGITS=8;

function fail(message,status=400,code,details){throw Object.assign(new Error(message),{status,code,details});}
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const token=()=>crypto.randomBytes(32).toString('base64url');
const emailCode=()=>String(crypto.randomInt(0,10**EMAIL_CODE_DIGITS)).padStart(EMAIL_CODE_DIGITS,'0');
const same=(a,b)=>String(a??'')===String(b??'');
const googleOnlyPasswordHash=value=>typeof value==='string'&&value.startsWith('!');
const isDemoOrganization=organization=>organization.demo_owner_user_id!==null||organization.demo_source_id!==null||organization.slug==='scale-demo-controles-20260908';
const isDemoAccountState=row=>row.is_demo_guest||isDemoOrganization(row);

function stateHash(value){return hash(JSON.stringify(value));}
function organizationIds(rows){return [...new Set(rows.map(row=>String(row.organization_id)))].sort((a,b)=>Number(a)-Number(b));}

async function accountState(c,userId,{lock=false}={}){
 const suffix=lock?' for update of m,o':'';
 const mine=(await c.query(`select m.organization_id,m.user_id,m.role,m.active,m.removed_at,o.name,o.slug,o.active as organization_active,o.deleted_at,
  o.demo_owner_user_id,o.demo_source_id,u.is_demo_guest from organization_members m join organizations o on o.id=m.organization_id
  join users u on u.id=m.user_id where m.user_id=$1 order by m.organization_id${suffix}`,[userId])).rows;
 if(mine.some(isDemoAccountState))fail('El Demo no permite eliminar cuentas.',403,'DEMO_ACCOUNT_DELETE_FORBIDDEN');
 const ids=organizationIds(mine);let all=[];
 if(ids.length)all=(await c.query(`select organization_id,user_id,role,active,removed_at from organization_members
  where organization_id=any($1::bigint[]) order by organization_id,user_id${lock?' for update':''}`,[ids])).rows;
 const canonical={
  mine:mine.map(row=>({organizationId:String(row.organization_id),name:row.name,role:row.role,active:row.active,removedAt:row.removed_at?new Date(row.removed_at).toISOString():null,organizationActive:row.organization_active,organizationDeletedAt:row.deleted_at?new Date(row.deleted_at).toISOString():null})),
  members:all.map(row=>({organizationId:String(row.organization_id),userId:String(row.user_id),role:row.role,active:row.active,removedAt:row.removed_at?new Date(row.removed_at).toISOString():null}))
 };
 const organizations=mine.filter(row=>row.active&&row.removed_at===null&&row.organization_active&&row.deleted_at===null).map(row=>{
  const active=all.filter(member=>same(member.organization_id,row.organization_id)&&member.active&&member.removed_at===null);
  const activeOwners=active.filter(member=>member.role==='owner');
  const soleActiveOwner=active.length===1&&row.role==='owner';
  const lastOwnerInShared=!soleActiveOwner&&row.role==='owner'&&activeOwners.length===1;
  return {organizationId:String(row.organization_id),name:row.name,role:row.role,activeMemberCount:active.length,activeOwnerCount:activeOwners.length,consequence:soleActiveOwner?'organization_soft_delete':'membership_deactivation',blocked:lastOwnerInShared};
 });
 const blockers=organizations.filter(row=>row.blocked).map(row=>({code:'LAST_ACTIVE_OWNER',organizationId:row.organizationId,organizationName:row.name,message:`Transferí la propiedad de “${row.name}” antes de eliminar tu cuenta.`}));
 return {stateHash:stateHash(canonical),organizations:organizations.map(({blocked,...row})=>row),blockers};
}

async function companyState(c,userId,organizationId,{lock=false}={}){
 const org=(await c.query(`select id,name,slug,active,deleted_at,demo_owner_user_id,demo_source_id from organizations where id=$1${lock?' for update':''}`,[organizationId])).rows[0];
 if(!org||!org.active||org.deleted_at)fail('Empresa no encontrada.',404,'ORGANIZATION_NOT_FOUND');
 if(isDemoOrganization(org))fail('El Demo no permite eliminar empresas.',403,'DEMO_ORGANIZATION_DELETE_FORBIDDEN');
 const membership=(await c.query(`select role,active,removed_at from organization_members where organization_id=$1 and user_id=$2${lock?' for update':''}`,[organizationId,userId])).rows[0];
 if(membership?.role!=='owner'||!membership.active||membership.removed_at)fail('Solo un dueño activo puede eliminar esta empresa.',403,'ORGANIZATION_DELETE_FORBIDDEN');
 const members=(await c.query(`select organization_id,user_id,role,active,removed_at from organization_members where organization_id=$1 order by user_id${lock?' for update':''}`,[organizationId])).rows;
 const active=members.filter(row=>row.active&&row.removed_at===null);
 const canonical={organization:{id:String(org.id),name:org.name,active:org.active,deletedAt:org.deleted_at?new Date(org.deleted_at).toISOString():null},members:members.map(row=>({userId:String(row.user_id),role:row.role,active:row.active,removedAt:row.removed_at?new Date(row.removed_at).toISOString():null}))};
 return {stateHash:stateHash(canonical),organization:{id:String(org.id),name:org.name,activeMemberCount:active.length},confirmation:DELETE_ACCOUNT_CONFIRMATION};
}

// Borrados globales (platform-admin): el objetivo es remoto y no es una membresía
// del actor, así que lo que invalida la vista previa es el estado del objetivo
// (issue #22). El id viaja en el payload de la vista previa.
const PLATFORM_DESTRUCTIVE_ACTIONS=new Set(['platform.user.delete','platform.agency.delete']);
async function platformState(c,action,targetId){
 const id=Number(targetId);
 if(!Number.isSafeInteger(id)||id<=0)fail('El objetivo del borrado no es válido.',400,'DESTRUCTIVE_TARGET_INVALID');
 if(action==='platform.user.delete'){
  const row=(await c.query('select id,email,is_demo_guest,deleted_at,anonymized_at from users where id=$1',[id])).rows[0];
  if(!row)fail('El usuario ya no existe.',404,'DESTRUCTIVE_TARGET_MISSING');
  if(row.deleted_at||row.anonymized_at)fail('El usuario ya fue eliminado.',409,'DESTRUCTIVE_TARGET_GONE');
  if(row.is_demo_guest||/@(demo|scale-demo)[.]example[.]invalid$/i.test(row.email))fail('La cuenta demo está protegida.',404,'DESTRUCTIVE_TARGET_PROTECTED');
  const target={id:String(row.id),kind:'user',email:row.email};
  return {stateHash:stateHash(target),target,confirmation:row.email,blockers:[]};
 }
 const row=(await c.query('select id,name,slug,active,deleted_at,demo_owner_user_id,demo_source_id from organizations where id=$1',[id])).rows[0];
 if(!row)fail('La agencia ya no existe.',404,'DESTRUCTIVE_TARGET_MISSING');
 if(!row.active||row.deleted_at)fail('La agencia ya fue eliminada.',409,'DESTRUCTIVE_TARGET_GONE');
 if(isDemoOrganization(row))fail('La agencia demo está protegida.',404,'DESTRUCTIVE_TARGET_PROTECTED');
 const target={id:String(row.id),kind:'agency',name:row.name,slug:row.slug};
 return {stateHash:stateHash(target),target,confirmation:row.name,blockers:[]};
}
async function deriveState(c,userId,action,organizationId,options){
 if(PLATFORM_DESTRUCTIVE_ACTIONS.has(action))return platformState(c,action,options?.targetId);
 return action==='account.delete'?accountState(c,userId,options):companyState(c,userId,organizationId,options);
}

async function previewByRaw(c,userId,raw,{lock=false}={}){
 if(typeof raw!=='string'||!/^[-\w]{43}$/.test(raw))fail('La vista previa no es válida o venció.',409,'DELETION_PREVIEW_INVALID');
 const row=(await c.query(`select * from destructive_action_previews where token_hash=$1 and user_id=$2 and consumed_at is null and expires_at>now()${lock?' for update':''}`,[hash(raw),userId])).rows[0];
 if(!row)fail('La vista previa no es válida o venció.',409,'DELETION_PREVIEW_INVALID');
 return row;
}

async function assertFreshPreview(c,row,{lock=false}={}){
 const current=await deriveState(c,row.user_id,row.action,row.organization_id,{lock,targetId:row.payload?.target?.id??null});
 if(current.stateHash!==row.state_hash)fail('La empresa o sus miembros cambiaron. Generá una nueva vista previa.',409,'DELETION_PREVIEW_STALE');
 if(row.action==='account.delete'&&current.blockers.length)fail('La cuenta no se puede eliminar mientras seas el último dueño activo de una empresa compartida.',409,'LAST_ACTIVE_OWNER',{organizations:current.blockers});
 return current;
}

async function createPreview(db,userId,action,organizationId){
 const derived=await deriveState(db,userId,action,organizationId);
 const raw=token(),confirmation=action==='account.delete'?DELETE_ACCOUNT_CONFIRMATION:derived.confirmation;
 const payload=action==='account.delete'
  ?{memberships:derived.organizations,blockers:derived.blockers,account:{willBeAnonymized:true,sessionsWillBeRevoked:true,tenantDataWillBeRetained:true}}
  :{organization:derived.organization,consequences:{organizationWillBeSoftDeleted:true,allMemberAccessWillBeDeactivated:true,organizationSessionsWillBeRevoked:true,tenantDataWillBeRetained:true}};
 const saved=(await db.query(`insert into destructive_action_previews(token_hash,user_id,action,organization_id,state_hash,confirmation,payload,expires_at)
  values($1,$2,$3,$4,$5,$6,$7,now()+interval '${PREVIEW_MINUTES} minutes') returning expires_at`,[hash(raw),userId,action,organizationId,derived.stateHash,confirmation,JSON.stringify(payload)])).rows[0];
 return {id:raw,action,organizationId:organizationId===null?null:String(organizationId),confirmation,expiresAt:saved.expires_at,...payload,executable:action==='organization.delete'||derived.blockers.length===0};
}

async function issueProof(c,preview,method){
 const raw=token();
 const saved=(await c.query(`insert into destructive_auth_proofs(token_hash,preview_token_hash,user_id,action,organization_id,method,expires_at)
  values($1,$2,$3,$4,$5,$6,now()+interval '${PROOF_MINUTES} minutes') returning expires_at`,[hash(raw),preview.token_hash,preview.user_id,preview.action,preview.organization_id,method])).rows[0];
 return {proof:raw,method,action:preview.action,organizationId:preview.organization_id===null?null:String(preview.organization_id),expiresAt:saved.expires_at};
}

async function createEmailChallenge(db,userId,rawPreview){
 const c=await db.connect();
 try{
  await c.query('begin isolation level serializable');
  const account=(await c.query('select email from users where id=$1 and deleted_at is null for update',[userId])).rows[0];
  if(!account)fail('No pudimos confirmar la verificación por correo.',401,'EMAIL_REAUTH_INVALID');
  const preview=await previewByRaw(c,userId,rawPreview,{lock:true});
  await assertFreshPreview(c,preview,{lock:true});
  await c.query('delete from destructive_email_challenges where preview_token_hash=$1 and user_id=$2 and consumed_at is null',[preview.token_hash,userId]);
  const code=emailCode();
  await c.query(`insert into destructive_email_challenges(code_hash,preview_token_hash,user_id,expires_at) values($1,$2,$3,now()+interval '${EMAIL_CODE_MINUTES} minutes')`,[await bcrypt.hash(code,12),preview.token_hash,userId]);
  await c.query('commit');return {email:account.email,code};
 }catch(error){await c.query('rollback');throw error;}finally{c.release();}
}

async function consumeEmailChallenge(db,userId,rawPreview,code){
 const c=await db.connect();
 try{
  await c.query('begin isolation level serializable');
  const account=(await c.query('select id from users where id=$1 and deleted_at is null for update',[userId])).rows[0];
  if(!account)fail('No pudimos confirmar la verificación por correo.',401,'EMAIL_REAUTH_INVALID');
  let preview;
  try{preview=await previewByRaw(c,userId,rawPreview,{lock:true});}
  catch(error){if(error.code==='DELETION_PREVIEW_INVALID')fail('No pudimos confirmar la verificación por correo.',401,'EMAIL_REAUTH_INVALID');throw error;}
  await assertFreshPreview(c,preview,{lock:true});
  const challenge=(await c.query(`select * from destructive_email_challenges where preview_token_hash=$1 and user_id=$2
   and consumed_at is null and expires_at>now() order by created_at desc limit 1 for update`,[preview.token_hash,userId])).rows[0];
  if(!challenge||!await bcrypt.compare(code,challenge.code_hash))fail('No pudimos confirmar la verificación por correo.',401,'EMAIL_REAUTH_INVALID');
  await c.query('update destructive_email_challenges set consumed_at=now() where id=$1',[challenge.id]);
  const proof=await issueProof(c,preview,'email');
  await c.query('commit');return proof;
 }catch(error){await c.query('rollback');throw error;}finally{c.release();}
}

export async function googleRecentAuthBinding(db,userId,rawPreview){
 const account=(await db.query('select password_hash from users where id=$1 and deleted_at is null',[userId])).rows[0];
 if(!account||!googleOnlyPasswordHash(account.password_hash))fail('Usá tu contraseña actual para confirmar esta operación.',409,'GOOGLE_REAUTH_NOT_ALLOWED');
 const preview=await previewByRaw(db,userId,rawPreview);
 await assertFreshPreview(db,preview);
 return {previewHash:preview.token_hash,action:preview.action,organizationId:preview.organization_id===null?null:String(preview.organization_id)};
}

export async function issueGoogleRecentAuthHandoff(db,{userId,previewHash,profile}){
 if(profile?.email_verified!==true)fail('Google no confirmó tu correo.',401,'GOOGLE_IDENTITY_UNVERIFIED');
 const email=String(profile.email||'').trim().toLowerCase();
 const c=await db.connect();
 try{
  await c.query('begin isolation level serializable');
  const account=(await c.query('select id,email,password_hash from users where id=$1 and deleted_at is null for update',[userId])).rows[0];
  if(!account||account.email!==email)fail('La cuenta de Google no coincide con la sesión activa.',401,'GOOGLE_IDENTITY_MISMATCH');
  if(!googleOnlyPasswordHash(account.password_hash))fail('Usá tu contraseña actual para confirmar esta operación.',409,'GOOGLE_REAUTH_NOT_ALLOWED');
  const preview=(await c.query('select * from destructive_action_previews where token_hash=$1 and user_id=$2 and consumed_at is null and expires_at>now() for update',[previewHash,userId])).rows[0];
  if(!preview)fail('La vista previa no es válida o venció.',409,'DELETION_PREVIEW_INVALID');
  await assertFreshPreview(c,preview,{lock:true});
  const raw=token();
  await c.query("insert into destructive_google_handoffs(token_hash,preview_token_hash,user_id,expires_at) values($1,$2,$3,now()+interval '60 seconds')",[hash(raw),preview.token_hash,userId]);
  await c.query('commit');return {ticket:raw};
 }catch(error){await c.query('rollback');throw error;}finally{c.release();}
}

async function optionalUpdate(c,table,sql,params){
 const exists=(await c.query('select to_regclass($1)::text as name',[table])).rows[0]?.name;
 if(exists)await c.query(sql,params);
}

async function executeAccountDeletion(c,userId,current){
 const softDeleted=current.organizations.filter(row=>row.consequence==='organization_soft_delete').map(row=>row.organizationId);
 const detached=current.organizations.map(row=>row.organizationId);
 if(softDeleted.length)await c.query('update organizations set active=false,deleted_at=now(),deleted_by_user_id=$1 where id=any($2::bigint[])',[userId,softDeleted]);
 await c.query('update organization_members set active=false,removed_at=coalesce(removed_at,now()) where user_id=$1',[userId]);
 await c.query('delete from sessions where user_id=$1',[userId]);
 await c.query('delete from oauth_states where recent_auth_user_id=$1',[userId]);
 await c.query('delete from destructive_google_handoffs where user_id=$1',[userId]);
 await c.query('delete from destructive_email_challenges where user_id=$1',[userId]);
 await c.query('update destructive_auth_proofs set consumed_at=coalesce(consumed_at,now()) where user_id=$1',[userId]);
 await optionalUpdate(c,'oauth_handoffs','delete from oauth_handoffs where user_id=$1',[userId]);
 await optionalUpdate(c,'user_personal_identities',"update user_personal_identities set full_name='Deleted account',photo_url=null,updated_at=now() where user_id=$1",[userId]);
 await optionalUpdate(c,'agency_user_profiles',"update agency_user_profiles set full_name='Deleted account',photo_url=null,updated_at=now() where user_id=$1",[userId]);
 await optionalUpdate(c,'agency_collaborators',"update agency_collaborators set full_name='Deleted account',email=null,photo_url=null,updated_at=now() where user_id=$1",[userId]);
 await optionalUpdate(c,'agency_access_requests',"update agency_access_requests set full_name='Deleted account' where user_id=$1",[userId]);
 const anonymous=`deleted+${userId}+${crypto.randomBytes(8).toString('hex')}@deleted.invalid`;
 await c.query("update users set email=$2,password_hash='!deleted-account',google_photo_url=null,google_full_name=null,deleted_at=now(),anonymized_at=now() where id=$1",[userId,anonymous]);
 await c.query('update account_closure_requests set cancelled_at=coalesce(cancelled_at,now()) where user_id=$1',[userId]);
 return {organizationsSoftDeleted:softDeleted,membershipsDeactivated:detached};
}

async function executeCompanyDeletion(c,userId,organizationId){
 await c.query('update organizations set active=false,deleted_at=now(),deleted_by_user_id=$2 where id=$1',[organizationId,userId]);
 await c.query('update organization_members set active=false,removed_at=coalesce(removed_at,now()) where organization_id=$1',[organizationId]);
 await c.query('delete from sessions where organization_id=$1',[organizationId]);
 await optionalUpdate(c,'oauth_handoffs','delete from oauth_handoffs where organization_id=$1',[organizationId]);
 return {organizationId:String(organizationId)};
}

function assertProofFormat(recentAuthProof){
 if(typeof recentAuthProof!=='string'||!/^[-\w]{43}$/.test(recentAuthProof))fail('Volvé a confirmar tu identidad.',401,'RECENT_AUTH_REQUIRED');
}
async function lockValidProof(c,{userId,preview,recentAuthProof}){
 assertProofFormat(recentAuthProof);
 const proof=(await c.query(`select * from destructive_auth_proofs where token_hash=$1 and preview_token_hash=$2 and user_id=$3
  and action=$4 and organization_id is not distinct from $5 and consumed_at is null and expires_at>now() and created_at >= $6 for update`,[hash(recentAuthProof),preview.token_hash,userId,preview.action,preview.organization_id,preview.created_at])).rows[0];
 if(!proof)fail('La confirmación de identidad no es válida o venció.',401,'RECENT_AUTH_INVALID');
 return proof;
}
async function consumeProof(c,{preview,proof}){
 await c.query('update destructive_auth_proofs set consumed_at=now() where token_hash=$1',[proof.token_hash]);
 await c.query('update destructive_action_previews set consumed_at=now() where token_hash=$1',[preview.token_hash]);
}

/** Vista previa de un borrado global (platform-admin): mismo patrón que la cuenta propia. */
export async function createPlatformPreview(db,{userId,action,organizationId=null,targetId}){
 if(!PLATFORM_DESTRUCTIVE_ACTIONS.has(action))fail('Operación de borrado inválida.',400,'DESTRUCTIVE_ACTION_INVALID');
 const derived=await platformState(db,action,targetId);
 const raw=token();
 const payload={target:derived.target,consequences:{targetWillBeSoftDeleted:true,accessWillBeRevoked:true,sessionsWillBeRevoked:true,tenantDataWillBeRetained:true}};
 const saved=(await db.query(`insert into destructive_action_previews(token_hash,user_id,action,organization_id,state_hash,confirmation,payload,expires_at)
  values($1,$2,$3,$4,$5,$6,$7,now()+interval '${PREVIEW_MINUTES} minutes') returning expires_at`,[hash(raw),userId,action,organizationId,derived.stateHash,derived.confirmation,JSON.stringify(payload)])).rows[0];
 return {id:raw,action,organizationId:organizationId===null?null:String(organizationId),confirmation:derived.confirmation,expiresAt:saved.expires_at,...payload};
}

/** Consume la prueba y la vista previa de un borrado global antes de ejecutarlo. */
export async function consumePlatformDeletionProof(c,{userId,previewId,confirmation,recentAuthProof,action,organizationId=null}){
 // Primero la prueba: sin ella no hay operación que valga (401 claro, no un 409 de vista previa).
 assertProofFormat(recentAuthProof);
 const preview=await previewByRaw(c,userId,previewId,{lock:true});
 if(preview.action!==action||!same(preview.organization_id,organizationId))fail('La vista previa no corresponde a esta operación.',409,'DELETION_SCOPE_MISMATCH');
 if(confirmation!==preview.confirmation)fail(`Escribí exactamente “${preview.confirmation}” para confirmar.`,400,'CONFIRMATION_MISMATCH');
 const proof=await lockValidProof(c,{userId,preview,recentAuthProof});
 const current=await assertFreshPreview(c,preview,{lock:true});
 await consumeProof(c,{preview,proof});
 return {preview,confirmation:preview.confirmation,target:current.target??null};
}

async function executeDeletion({db,user,previewId,recentAuthProof,confirmation,expectedAction,expectedOrganizationId=null}){
 if(expectedAction==='organization.delete'&&!same(user.organization_id,expectedOrganizationId))fail('La empresa no corresponde a tu sesión actual.',403,'DELETION_SCOPE_MISMATCH');
 const c=await db.connect();
 try{
  await c.query('begin isolation level serializable');
  const account=(await c.query('select id from users where id=$1 and deleted_at is null for update',[user.id])).rows[0];
  if(!account)fail('La cuenta ya no está disponible.',409,'ACCOUNT_UNAVAILABLE');
  const preview=await previewByRaw(c,user.id,previewId,{lock:true});
  if(preview.action!==expectedAction||(expectedAction==='organization.delete'&&!same(preview.organization_id,expectedOrganizationId)))fail('La vista previa no corresponde a esta operación.',409,'DELETION_SCOPE_MISMATCH');
  if(confirmation!==preview.confirmation)fail(`Escribí exactamente “${preview.confirmation}” para confirmar.`,400,'CONFIRMATION_MISMATCH');
  const proof=await lockValidProof(c,{userId:user.id,preview,recentAuthProof});
  const current=await assertFreshPreview(c,preview,{lock:true});
  await consumeProof(c,{preview,proof});
  const result=preview.action==='account.delete'?await executeAccountDeletion(c,user.id,current):await executeCompanyDeletion(c,user.id,preview.organization_id);
  await c.query('commit');return {action:preview.action,...result};
 }catch(error){await c.query('rollback');throw error;}finally{c.release();}
}

export async function accountSecurity({req,res,url,db,session,body,send,parseCookies,cookie,throttle,sendDestructiveEmailCode,emailAvailable=true}){
 const companyMatch=url.pathname.match(/^\/api\/auth\/organizations\/(\d+)\/deletion(?:\/preview)?$/);
 if(!url.pathname.startsWith('/api/auth/account')&&!companyMatch)return false;
 if(url.pathname==='/api/auth/account/recent-auth/google/start')return false;
 const limit=throttle||(async()=>true);
 if(url.pathname==='/api/auth/account/closure/cancel'&&req.method==='POST'){
  try{
   const value=await body(req);const email=typeof value?.email==='string'?value.email.trim().toLowerCase():'';
   if(!email||typeof value?.password!=='string'||!value.password)fail('Ingresá tu correo y contraseña actual para cancelar el cierre.');
   if(!await limit(db,'account-closure-cancel:'+email,5))fail('Demasiados intentos. Esperá 15 minutos.',429);
   const account=(await db.query('select id,password_hash from users where email=$1 and deleted_at is null',[email])).rows[0];
   if(!account||!await bcrypt.compare(value.password,account.password_hash))fail('No pudimos confirmar tus credenciales.',401);
   const changed=(await db.query('update account_closure_requests set cancelled_at=now() where user_id=$1 and cancelled_at is null and recoverable_until>now() returning user_id',[account.id])).rows[0];
   if(!changed)fail('No hay un cierre recuperable para cancelar.',404);
   return send(res,200,{ok:true});
  }catch(error){console.error(JSON.stringify({event:'account_security_cancel_error',status:error.status||500,code:error.code}));send(res,error.status||500,{...(error.code?{code:error.code}:{}),error:error.status?error.message:'No se pudo cancelar el cierre.'});return true;}
 }
 const user=await session(req);if(!user){send(res,401,{error:'No autenticado'});return true;}
 const currentSession=parseCookies(req).scale_session||'';
 try{
  if(url.pathname==='/api/auth/account/deletion/preview'&&req.method==='POST')return send(res,200,{preview:await createPreview(db,user.id,'account.delete',null)});
  if(companyMatch&&!same(user.organization_id,companyMatch[1]))fail('La empresa no corresponde a tu sesión actual.',403,'DELETION_SCOPE_MISMATCH');
  if(companyMatch&&url.pathname.endsWith('/preview')&&req.method==='POST')return send(res,200,{preview:await createPreview(db,user.id,'organization.delete',companyMatch[1])});
  if(url.pathname==='/api/auth/account/recent-auth/password'&&req.method==='POST'){
   const value=await body(req);if(!await limit(db,'destructive-reauth:'+user.id,5))fail('Demasiados intentos. Esperá 15 minutos.',429);
   const preview=await previewByRaw(db,user.id,value?.previewId||'');await assertFreshPreview(db,preview);
   const account=(await db.query('select password_hash from users where id=$1 and deleted_at is null',[user.id])).rows[0];
   if(!account||account.password_hash.startsWith('!'))fail('Esta cuenta debe confirmar su identidad con Google.',409,'PASSWORD_REAUTH_UNAVAILABLE');
   if(typeof value?.password!=='string'||!value.password||!await bcrypt.compare(value.password,account.password_hash))fail('No pudimos confirmar tu contraseña.',401,'PASSWORD_REAUTH_FAILED');
   return send(res,200,await issueProof(db,preview,'password'));
  }
  if(url.pathname==='/api/auth/account/recent-auth/email/request'&&req.method==='POST'){
   const value=await body(req);
   if(!emailAvailable||typeof sendDestructiveEmailCode!=='function')fail('La verificación por correo todavía no está disponible. Usá Google para confirmar esta operación.',503,'EMAIL_REAUTH_UNAVAILABLE');
   if(!await limit(db,'destructive-email-reauth-send:'+user.id,3))fail('Demasiados intentos. Esperá 15 minutos.',429,'EMAIL_REAUTH_RATE_LIMITED');
   const challenge=await createEmailChallenge(db,user.id,value?.previewId||'');
   if(!await sendDestructiveEmailCode(challenge.email,challenge.code).catch(()=>false))fail('No pudimos enviar la verificación por correo. Intentá nuevamente en unos minutos.',503,'EMAIL_REAUTH_UNAVAILABLE');
   return send(res,202,{ok:true,message:'Si podemos confirmar esta operación, enviamos un código a tu correo registrado.'});
  }
  if(url.pathname==='/api/auth/account/recent-auth/email/complete'&&req.method==='POST'){
   const value=await body(req),code=typeof value?.code==='string'?value.code:'';
   if(!/^\d{8}$/.test(code))fail('No pudimos confirmar la verificación por correo.',401,'EMAIL_REAUTH_INVALID');
   if(!await limit(db,'destructive-email-reauth-attempt:'+user.id,5))fail('Demasiados intentos. Esperá 15 minutos.',429,'EMAIL_REAUTH_RATE_LIMITED');
   return send(res,200,await consumeEmailChallenge(db,user.id,value?.previewId||'',code));
  }
  if(url.pathname==='/api/auth/account/recent-auth/google/complete'&&req.method==='POST'){
   const value=await body(req),raw=value?.ticket;
   if(typeof raw!=='string'||!/^[-\w]{43}$/.test(raw))fail('La verificación con Google no es válida o venció.',401,'GOOGLE_REAUTH_INVALID');
   const c=await db.connect();
   try{
    await c.query('begin');
    const handoff=(await c.query('select preview_token_hash from destructive_google_handoffs where token_hash=$1 and user_id=$2 and expires_at>now() for update',[hash(raw),user.id])).rows[0];
    if(!handoff)fail('La verificación con Google no es válida o venció.',401,'GOOGLE_REAUTH_INVALID');
    const account=(await c.query('select password_hash from users where id=$1 and deleted_at is null for update',[user.id])).rows[0];
    if(!account||!googleOnlyPasswordHash(account.password_hash))fail('Usá tu contraseña actual para confirmar esta operación.',409,'GOOGLE_REAUTH_NOT_ALLOWED');
    await c.query('delete from destructive_google_handoffs where token_hash=$1',[hash(raw)]);
    const preview=(await c.query('select * from destructive_action_previews where token_hash=$1 and user_id=$2 and consumed_at is null and expires_at>now() for update',[handoff.preview_token_hash,user.id])).rows[0];
    if(!preview)fail('La vista previa no es válida o venció.',409,'DELETION_PREVIEW_INVALID');
    await assertFreshPreview(c,preview,{lock:true});
    const proof=await issueProof(c,preview,'google');await c.query('commit');return send(res,200,proof);
   }catch(error){await c.query('rollback');throw error;}finally{c.release();}
  }
  const accountDelete=url.pathname==='/api/auth/account/deletion';
  const companyDelete=companyMatch&&!url.pathname.endsWith('/preview');
  if((accountDelete||companyDelete)&&req.method==='POST'){
   const value=await body(req);
   const result=await executeDeletion({db,user,previewId:value?.previewId,recentAuthProof:value?.recentAuthProof,confirmation:value?.confirmation,expectedAction:accountDelete?'account.delete':'organization.delete',expectedOrganizationId:companyDelete?companyMatch[1]:null});
   const clear=result.action==='account.delete'||same(user.organization_id,result.organizationId);
   return send(res,200,{ok:true,deleted:true,...result},{...(clear?{'Set-Cookie':cookie('scale_session','',0)}:{})});
  }
  if(url.pathname==='/api/auth/account/sessions'&&req.method==='GET'){
   const records=(await db.query('select id,created_at,expires_at,id=$2 as current from sessions where user_id=$1 and expires_at>now() order by created_at desc',[user.id,currentSession])).rows;
   return send(res,200,{sessions:records});
  }
  const sessionMatch=url.pathname.match(/^\/api\/auth\/account\/sessions\/([a-f0-9]{64})$/);
  if(sessionMatch&&req.method==='DELETE'){
   const removed=(await db.query('delete from sessions where id=$1 and user_id=$2 returning id',[sessionMatch[1],user.id])).rows[0];
   if(!removed)fail('La sesión no existe o ya venció.',404);
   return send(res,200,{ok:true},{...(sessionMatch[1]===currentSession?{'Set-Cookie':cookie('scale_session','',0)}:{})});
  }
  if(url.pathname==='/api/auth/account/closure'&&req.method==='GET'){
   const request=(await db.query('select requested_at,recoverable_until,cancelled_at from account_closure_requests where user_id=$1 and cancelled_at is null order by requested_at desc limit 1',[user.id])).rows[0]||null;
   return send(res,200,{closure:request,recoveryDays:RECOVERY_DAYS});
  }
  if(url.pathname==='/api/auth/account/closure'&&req.method==='POST'){
   if(user.demo_owner_user_id)fail('La cuenta de demostración no se puede cerrar desde el demo.',403);
   const value=await body(req);
   if(!await limit(db,'account-closure:'+user.id,5))fail('Demasiados intentos. Esperá 15 minutos.',429);
   if(value?.confirmation!==CLOSE_CONFIRMATION)fail(`Escribí “${CLOSE_CONFIRMATION}” para confirmar el cierre.`);
   if(typeof value?.password!=='string'||!value.password)fail('Ingresá tu contraseña actual para confirmar el cierre.');
   const account=(await db.query('select password_hash from users where id=$1 and deleted_at is null',[user.id])).rows[0];
   if(!account||!await bcrypt.compare(value.password,account.password_hash))fail('No pudimos confirmar tu contraseña.',401);
   const soleOwner=(await db.query(`select o.name from organization_members m join organizations o on o.id=m.organization_id
    where m.user_id=$1 and m.role='owner' and m.active=true and not exists(
      select 1 from organization_members other where other.organization_id=m.organization_id and other.user_id<>m.user_id and other.role='owner' and other.active=true
    ) limit 1`,[user.id])).rows[0];
   if(soleOwner)fail(`Transferí o cerrá primero la empresa “${soleOwner.name}”. Debe quedar otro dueño activo para conservar sus datos.`,409);
   const c=await db.connect();
   try{
    await c.query('begin');
    await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);
    await c.query(`insert into account_closure_requests(user_id,recoverable_until) values($1,now()+interval '${RECOVERY_DAYS} days')
      on conflict(user_id) do update set requested_at=now(),recoverable_until=excluded.recoverable_until,cancelled_at=null`,[user.id]);
    await c.query('delete from sessions where user_id=$1',[user.id]);
    await c.query('commit');
   }catch(error){await c.query('rollback');throw error;}finally{c.release();}
   return send(res,202,{ok:true,recoverableUntil:new Date(Date.now()+RECOVERY_DAYS*86400000).toISOString()},{'Set-Cookie':cookie('scale_session','',0)});
  }
  send(res,405,{error:'Método no permitido'});return true;
 }catch(error){
  console.error(JSON.stringify({event:'account_security_error',status:error.status||500,code:error.code}));
  send(res,error.status||500,{...(error.code?{code:error.code}:{}),error:error.status?error.message:'No se pudo completar la operación.',...(error.details?{details:error.details}:{})});return true;
 }
}

export {CLOSE_CONFIRMATION,DELETE_ACCOUNT_CONFIRMATION,RECOVERY_DAYS,optionalUpdate};
