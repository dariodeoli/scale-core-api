const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
// Filtro canónico de agencia administrable (fuente única para el panel global):
// excluye demos, agencias marcadas como de prueba y agencias ya eliminadas.
export const realOrganization=alias=>`${alias}.demo_owner_user_id is null and ${alias}.demo_source_id is null and ${alias}.deleted_at is null and lower(${alias}.slug) not in ('scale-demo-controles-20260908','agenciaprueba','agencia-prueba') and lower(${alias}.name)<>'agenciaprueba'`;
const organizationId=value=>{
 if(!/^[1-9]\d{0,18}$/.test(String(value))||BigInt(value)>9223372036854775807n)fail('Agencia inválida.');
 return String(value);
};
const state=value=>{
 if(value!==null&&value!==undefined&&value!=='active'&&value!=='suspended')fail('Estado interno de suscripción inválido.');
 return value??null;
};
const reason=value=>{
 if(typeof value!=='string')fail('El motivo es obligatorio.');
 const normalized=value.trim().replace(/\s+/g,' ');
 if(normalized.length<3||normalized.length>280)fail('El motivo debe tener entre 3 y 280 caracteres.');
 return normalized;
};
const expiration=value=>{
 if(value===undefined||value===null||value==='')return null;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))fail('La expiración debe ser una fecha ISO UTC válida.');
 const date=new Date(value);if(!Number.isFinite(date.getTime())||date.getTime()<=Date.now())fail('La expiración debe estar en el futuro.');
 return date.toISOString();
};
export function parseInternalSubscriptionUpdate(input){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('Solicitud inválida.');
 const keys=Object.keys(input);if(keys.some(key=>!['state','reason','expires_at'].includes(key))||!Object.hasOwn(input,'state'))fail('Solo se permiten state, reason y expires_at.');
 const next=state(input.state);
 if(next===null){
  if(Object.hasOwn(input,'reason')||Object.hasOwn(input,'expires_at'))fail('Eliminar el estado interno no acepta motivo ni expiración.');
  return {state:null,reason:null,expiresAt:null};
 }
 return {state:next,reason:reason(input.reason),expiresAt:expiration(input.expires_at)};
}
export async function inspectInternalSubscription(db,organization){
 const id=organizationId(organization);
 const result=await db.query(`select o.id as organization_id,o.name as organization_name,o.slug,o.active as organization_active,
   s.currency,s.trial_started_at,s.trial_ends_at,s.due_at,s.paid_through_at,s.stripe_status as provider_status,
   ps.state as internal_state,ps.reason as internal_reason,ps.expires_at as internal_expires_at,ps.updated_at as internal_updated_at,
   u.email as internal_updated_by
   from organizations o left join organization_subscriptions s on s.organization_id=o.id
   left join platform_subscription_states ps on ps.organization_id=s.organization_id
   left join users u on u.id=ps.updated_by_user_id
   where o.id=$1 and ${realOrganization('o')}`,[id]);
 const row=result.rows[0];if(!row)fail('Agencia no encontrada.',404);
 return {agency:{id:row.organization_id,name:row.organization_name,slug:row.slug,active:row.organization_active},subscription:row.currency?{
  currency:row.currency,trial_started_at:row.trial_started_at,trial_ends_at:row.trial_ends_at,due_at:row.due_at,paid_through_at:row.paid_through_at,provider_status:row.provider_status,
  internal_state:row.internal_state,internal_reason:row.internal_reason,internal_expires_at:row.internal_expires_at,internal_updated_at:row.internal_updated_at,internal_updated_by:row.internal_updated_by
 }:null};
}
export async function updateInternalSubscription(db,organization,input,actorUserId){
 const id=organizationId(organization),next=parseInternalSubscriptionUpdate(input);
 const subscribed=(await db.query(`select s.organization_id from organization_subscriptions s join organizations o on o.id=s.organization_id
   where s.organization_id=$1 and ${realOrganization('o')} for update`,[id])).rows[0];
 if(!subscribed)fail('La agencia no tiene una suscripción interna administrable.',409);
 if(next.state===null)await db.query('delete from platform_subscription_states where organization_id=$1',[id]);
 else await db.query(`insert into platform_subscription_states(organization_id,state,reason,expires_at,updated_by_user_id)
  values($1,$2,$3,$4,$5) on conflict(organization_id) do update set state=excluded.state,reason=excluded.reason,expires_at=excluded.expires_at,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()`,[id,next.state,next.reason,next.expiresAt,actorUserId]);
 return {change:next,view:await inspectInternalSubscription(db,id)};
}
