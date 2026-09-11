import crypto from 'node:crypto';
import {startTrial} from './subscription-billing.js';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export function trialDetails(params){
 if(params.get('signup')!=='1')return null;
 const name=(params.get('company')||'').trim(),currency=params.get('currency');
 if(name.length<2||name.length>160||/[\u0000-\u001f\u007f]/.test(name)||!['USD','PYG'].includes(currency)||params.get('consent')!=='1')fail('Completá el nombre de tu agencia, la moneda y aceptá las condiciones de la prueba.');
 if(params.has('invite'))fail('Usá la invitación o el registro de una agencia nueva, no ambos.');
 return {name,currency};
}
// The Google callback owns the transaction. Profile must have been verified by
// Google's token/userinfo exchange, never supplied by a browser request body.
export async function registerTrial(c,profile,details){
 const email=String(profile.email||'').trim().toLowerCase();
 if(profile.email_verified!==true||!/^\S+@\S+\.\S+$/.test(email))fail('Verificá tu correo con Google.',403);
 await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['trial-registration:'+email]);
 const user=(await c.query("insert into users(email,password_hash) values($1,'!google-trial-no-password') on conflict(email) do update set email=excluded.email returning id,is_demo_guest",[email])).rows[0];
 if(user.is_demo_guest)fail('Usá tu cuenta personal de Google, no una sesión de demostración.',403);
 const previous=(await c.query('select organization_id from os_trial_registrations where user_id=$1',[user.id])).rows[0];
 if(previous){
  const member=(await c.query('select 1 from organization_members m join organizations o on o.id=m.organization_id where m.user_id=$1 and m.organization_id=$2 and m.active and m.removed_at is null and o.active',[user.id,previous.organization_id])).rows[0];
  if(!member)fail('Esta cuenta ya inició una prueba. Contactá al dueño para recuperar el acceso.',403);
  return {userId:user.id,organizationId:previous.organization_id};
 }
 const org=(await c.query('insert into organizations(slug,name) values($1,$2) returning id',['agencia-'+crypto.randomUUID(),details.name])).rows[0];
 await c.query("select set_config('app.current_user',$1,true),set_config('app.current_organization',$2,true)",[String(user.id),String(org.id)]);
 await c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org.id,user.id]);
 await c.query('insert into agency_settings(organization_id,default_currency) values($1,$2)',[org.id,details.currency]);
 const candidate=String(profile.name||'').trim().slice(0,120),name=candidate.length>=2?candidate:email.slice(0,120);
 await c.query('insert into agency_user_profiles(organization_id,user_id,full_name) values($1,$2,$3) on conflict(organization_id,user_id) do nothing',[org.id,user.id,name]);
 await startTrial(c,org.id,details.currency);
 await c.query("insert into os_trial_registrations(user_id,organization_id,consent_version) values($1,$2,'2026-09-10:30d-10usd-50000pyg-2d-grace')",[user.id,org.id]);
 return {userId:user.id,organizationId:org.id};
}
