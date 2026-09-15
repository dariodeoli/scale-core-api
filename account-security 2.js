import bcrypt from 'bcryptjs';

const CLOSE_CONFIRMATION='CERRAR MI CUENTA';
const RECOVERY_DAYS=30;

function fail(message,status=400){throw Object.assign(new Error(message),{status});}

export async function accountSecurity({req,res,url,db,session,body,send,parseCookies,cookie}){
 if(!url.pathname.startsWith('/api/auth/account'))return false;
 if(url.pathname==='/api/auth/account/closure/cancel'&&req.method==='POST'){
  try{
   const value=await body(req);
   const email=typeof value?.email==='string'?value.email.trim().toLowerCase():'';
   if(!email||typeof value?.password!=='string'||!value.password)fail('Ingresá tu correo y contraseña actual para cancelar el cierre.');
   const account=(await db.query('select id,password_hash from users where email=$1',[email])).rows[0];
   if(!account||!await bcrypt.compare(value.password,account.password_hash))fail('No pudimos confirmar tus credenciales.',401);
   const changed=(await db.query(`update account_closure_requests set cancelled_at=now() where user_id=$1 and cancelled_at is null and recoverable_until>now() returning user_id`,[account.id])).rows[0];
   if(!changed)fail('No hay un cierre recuperable para cancelar.',404);
   return send(res,200,{ok:true});
  }catch(error){console.error(JSON.stringify({event:'account_security_cancel_error',status:error.status||500,code:error.code}));send(res,error.status||500,{error:error.status?error.message:'No se pudo cancelar el cierre.'});return true;}
 }
 const user=await session(req);
 if(!user){send(res,401,{error:'No autenticado'});return true;}
 const currentSession=parseCookies(req).scale_session||'';
 try{
  if(url.pathname==='/api/auth/account/sessions'&&req.method==='GET'){
   const records=(await db.query(`select id,created_at,expires_at,id=$2 as current
    from sessions where user_id=$1 and expires_at>now() order by created_at desc`,[user.id,currentSession])).rows;
   return send(res,200,{sessions:records});
  }
  const sessionMatch=url.pathname.match(/^\/api\/auth\/account\/sessions\/([a-f0-9]{64})$/);
  if(sessionMatch&&req.method==='DELETE'){
   const removed=(await db.query('delete from sessions where id=$1 and user_id=$2 returning id',[sessionMatch[1],user.id])).rows[0];
   if(!removed)fail('La sesión no existe o ya venció.',404);
   return send(res,200,{ok:true},{...(sessionMatch[1]===currentSession?{'Set-Cookie':cookie('scale_session','',0)}:{})});
  }
  if(url.pathname==='/api/auth/account/closure'&&req.method==='GET'){
   const request=(await db.query(`select requested_at,recoverable_until,cancelled_at
    from account_closure_requests where user_id=$1 and cancelled_at is null
    order by requested_at desc limit 1`,[user.id])).rows[0]||null;
   return send(res,200,{closure:request,recoveryDays:RECOVERY_DAYS});
  }
  if(url.pathname==='/api/auth/account/closure'&&req.method==='POST'){
   if(user.demo_owner_user_id)fail('La cuenta de demostración no se puede cerrar desde el demo.',403);
   const value=await body(req);
   if(value?.confirmation!==CLOSE_CONFIRMATION)fail(`Escribí “${CLOSE_CONFIRMATION}” para confirmar el cierre.`);
   if(typeof value?.password!=='string'||!value.password)fail('Ingresá tu contraseña actual para confirmar el cierre.');
   const account=(await db.query('select password_hash from users where id=$1',[user.id])).rows[0];
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
 }catch(error){console.error(JSON.stringify({event:'account_security_error',status:error.status||500,code:error.code}));send(res,error.status||500,{error:error.status?error.message:'No se pudo completar la operación.'});return true;}
}

export {CLOSE_CONFIRMATION,RECOVERY_DAYS};
