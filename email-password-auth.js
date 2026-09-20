import {fail} from './suite-validation.js';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {claimInvite,resolveInvite} from './invite-links.js';
import {trialDetailsFromInput,registerTrial} from './trial-registration.js';
import {throttle,validatePassword} from './password-access.js';

const tokenHash=value=>crypto.createHash('sha256').update(value).digest('hex');
const emailOf=value=>{
 const email=typeof value==='string'?value.trim().toLowerCase():'';
 if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254)fail('Ingresá un correo válido.');
 return email;
};
const nameOf=value=>{
 const name=typeof value==='string'?value.trim().replace(/\s+/g,' '):'';
 if(name.length>160||/[\u0000-\u001f\u007f]/.test(name))fail('El nombre no es válido.');
 return name;
};
const verificationToken=()=>crypto.randomBytes(32).toString('hex');
const validToken=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

async function issueVerification(client,{userId,purpose,inviteLinkId=null,payload={}}){
 const token=verificationToken();
 // A newer email invalidates earlier links for the same unfinished flow.
 await client.query('delete from auth_email_verifications where user_id=$1 and purpose=$2 and used_at is null',[userId,purpose]);
 await client.query("insert into auth_email_verifications(user_id,purpose,token_hash,invite_link_id,payload,expires_at) values($1,$2,$3,$4,$5,now()+interval '24 hours')",[userId,purpose,tokenHash(token),inviteLinkId,JSON.stringify(payload)]);
 return token;
}

async function createUnverifiedUser(client,{email,password}){
 const existing=(await client.query('select id from users where email=$1 for update',[email])).rows[0];
 if(existing)fail('Ya existe una cuenta con este correo. Iniciá sesión o recuperá tu contraseña.',409);
 const passwordHash=await bcrypt.hash(password,12);
 return (await client.query('insert into users(email,password_hash,role) values($1,$2,$3) returning id,email',[email,passwordHash,'viewer'])).rows[0];
}

async function createOrRebindInviteUser(client,{email,password}){
 const existing=(await client.query('select id,email,password_hash,email_verified_at from users where email=$1 for update',[email])).rows[0];
 if(!existing)return createUnverifiedUser(client,{email,password});
 // A verified account, or a password mismatch, must never let an invitation
 // replace an existing account's pending state.
 if(existing.email_verified_at||!await bcrypt.compare(password,existing.password_hash).catch(()=>false))fail('Ya existe una cuenta con este correo. Iniciá sesión o recuperá tu contraseña.',409);
 return existing;
}

async function queueVerification(sendVerification,email,token){
 // Delivery failures never activate access. Callers are told to retry instead
 // of being promised a message that was not accepted by the provider.
 return Boolean(await sendVerification(email,token).catch(()=>false));
}

export async function emailPasswordAuth({req,res,url,db,body,send,sendVerification,emailAvailable=true,cookie,id}){
 const path=url.pathname;
 if(!['/api/auth/password/register','/api/auth/password/invitations/register','/api/auth/password/verification/request','/api/auth/password/verify'].includes(path))return false;
 if(req.method!=='POST'){send(res,405,{error:'Método no permitido'});return true;}
 let client;
 try{
  const input=await body(req);
  if(path==='/api/auth/password/register'){
   if(!emailAvailable)fail('El registro con correo todavía no está disponible. Usá Google o contactá al administrador.',503);
   const email=emailOf(input.email),password=String(input.password||'');
   validatePassword(password,email);
   const trial=trialDetailsFromInput(input);
   if(!await throttle(db,'password-signup:'+email,3))fail('Intentá nuevamente en unos minutos.',429);
   client=await db.connect();await client.query('begin');
   const user=await createUnverifiedUser(client,{email,password});
   const token=await issueVerification(client,{userId:user.id,purpose:'trial',payload:{company:trial.name,currency:trial.currency,full_name:nameOf(input.full_name)}});
   await client.query('commit');client.release();client=null;
   if(!await queueVerification(sendVerification,email,token)){
    send(res,503,{error:'No pudimos enviar el correo de verificación. Volvé a solicitarlo en unos minutos.'});return true;
   }
   send(res,202,{message:'Revisá tu correo para verificar tu cuenta y activar la prueba de 30 días.'});return true;
  }
  if(path==='/api/auth/password/invitations/register'){
   if(!emailAvailable)fail('El registro con correo todavía no está disponible. Usá Google o contactá al administrador.',503);
   const email=emailOf(input.email),password=String(input.password||''),token=String(input.token||'');
   validatePassword(password,email);
   // Validate before any user write. The verification endpoint validates again
   // under the link lock, covering expiry/revocation while email is pending.
   const invite=await resolveInvite(db,token);
   if(!await throttle(db,'password-invite:'+email,3))fail('Intentá nuevamente en unos minutos.',429);
   client=await db.connect();await client.query('begin');
   // A valid replacement invite can restart an unfinished enrollment. The
   // user row and invite verification are locked/replaced in this transaction.
   const user=await createOrRebindInviteUser(client,{email,password});
   const verify=await issueVerification(client,{userId:user.id,purpose:'invite',inviteLinkId:invite.id,payload:{full_name:nameOf(input.full_name)||email}});
   await client.query('commit');client.release();client=null;
   if(!await queueVerification(sendVerification,email,verify)){
    send(res,503,{error:'No pudimos enviar el correo de verificación. Volvé a solicitarlo en unos minutos.'});return true;
   }
   send(res,202,{message:'Revisá tu correo para verificar tu cuenta. Recién entonces se solicitará o habilitará el acceso de esta invitación.'});return true;
  }
  if(path==='/api/auth/password/verification/request'){
   if(!emailAvailable)fail('La verificación por correo todavía no está disponible. Usá Google o contactá al administrador.',503);
   const email=emailOf(input.email);
   const allowed=await throttle(db,'verification-resend:'+email,3);
   if(allowed){
    client=await db.connect();await client.query('begin');
    const pending=(await client.query(`select u.id,u.email,v.purpose,v.invite_link_id,v.payload
      from users u join auth_email_verifications v on v.user_id=u.id
      where u.email=$1 and u.email_verified_at is null and v.used_at is null
      order by v.created_at desc limit 1 for update of v`,[email])).rows[0];
    let token=null;
    if(pending)token=await issueVerification(client,{userId:pending.id,purpose:pending.purpose,inviteLinkId:pending.invite_link_id,payload:pending.payload||{}});
    await client.query('commit');client.release();client=null;
    if(token&&!await queueVerification(sendVerification,email,token)){
     send(res,503,{error:'No pudimos enviar el correo de verificación. Volvé a solicitarlo en unos minutos.'});return true;
    }
   }
   send(res,202,{message:'Si hay una cuenta pendiente para ese correo, enviamos un nuevo enlace de verificación.'});return true;
  }
  const raw=String(input.token||'');
  if(!validToken(raw))fail('El enlace de verificación no es válido.');
  client=await db.connect();await client.query('begin');
  const saved=(await client.query(`select v.*,u.email from auth_email_verifications v join users u on u.id=v.user_id
    where v.token_hash=$1 and v.used_at is null and v.expires_at>now() for update of v,u`,[tokenHash(raw)])).rows[0];
  if(!saved)fail('El enlace venció o ya fue utilizado. Solicitá uno nuevo.');
  let account;
  const payload=saved.payload&&typeof saved.payload==='object'?saved.payload:{};
  const profile={email:saved.email,email_verified:true,name:nameOf(payload.full_name)||saved.email};
  if(saved.purpose==='trial'){
   const trial=trialDetailsFromInput({company:payload.company,currency:payload.currency,consent:true});
   account=await registerTrial(client,profile,trial);
  }else{
   account=await claimInvite(client,saved.invite_link_id,profile);
  }
  await client.query('update users set email_verified_at=coalesce(email_verified_at,now()) where id=$1',[saved.user_id]);
  await client.query('update auth_email_verifications set used_at=now() where id=$1',[saved.id]);
  await client.query('delete from auth_email_verifications where user_id=$1 and id<>$2',[saved.user_id,saved.id]);
  const sessionToken=id();
  await client.query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '7 days')",[sessionToken,account.userId,account.organizationId]);
  await client.query('commit');client.release();client=null;
  send(res,200,{ok:true,pending:account.pending===true,trial: saved.purpose==='trial'},{'Set-Cookie':cookie('scale_session',sessionToken,604800)});return true;
 }catch(error){
  if(client){try{await client.query('rollback');}catch{}client.release();}
  send(res,error.status||500,{error:error.status?error.message:'No se pudo completar el registro. Intentá nuevamente.'});return true;
 }
}
