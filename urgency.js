import {fail} from './suite-validation.js';

export function normalizeUrgency(value){
 if(value===null||value==='')return null;
 if(typeof value==='number'&&Number.isInteger(value)&&value>=1&&value<=5)return value;
 if(typeof value==='string'&&/^[1-5]$/.test(value))return Number(value);
 fail('Elegí una urgencia de 1 (baja) a 5 (crítica), o Sin definir');
}

// Caller holds the record lock and owns BEGIN/COMMIT: a later validation failure
// must roll back urgency together with the remaining detail and assignee draft.
export async function patchUrgency(c,user,kind,record,payload){
 if(!Object.hasOwn(payload,'urgency'))return;
 const table={projects:'agency_projects','work-orders':'agency_work_orders'}[kind];
 if(!table)fail('Este registro no admite urgencia');
 const roles=['owner','admin','management','production',...(kind==='work-orders'?['editor']:[])];
 if(!user||!roles.includes(user.role)||String(record.organization_id)!==String(user.organization_id))fail('Sin permiso para cambiar la urgencia',403);
 const member=(await c.query(`select m.role from organization_members m join organizations o on o.id=m.organization_id
  where m.user_id=$1 and m.organization_id=$2 and m.active and m.removed_at is null and o.active for share of m,o`,[user.id,user.organization_id])).rows[0];
 if(!member||!roles.includes(member.role))fail('Sin acceso activo para cambiar la urgencia',403);
 const value=normalizeUrgency(payload.urgency);
 await c.query(`update ${table} set urgency=$1 where id=$2 and organization_id=$3`,[value,record.id,user.organization_id]);
}
