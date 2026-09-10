import {fail,owned} from './suite-validation.js';

const readers=['owner','admin','management','finance','sales','production','editor','viewer'];
const managers=['owner','admin','management','production'];
const definitions={
 projects:{table:'agency_projects',links:'agency_project_assignees',key:'project_id',writers:managers},
 'work-orders':{table:'agency_work_orders',links:'agency_work_order_assignees',key:'work_order_id',writers:[...managers,'editor']},
};
const definition=kind=>Object.hasOwn(definitions,kind)?definitions[kind]:fail('Tipo de registro inválido');
function identifier(value,zero=false){
 if(typeof value==='number'&&!Number.isSafeInteger(value))fail('Identificador inválido');
 if(!['string','number'].includes(typeof value)||!/^\d{1,30}$/.test(String(value)))fail('Identificador inválido');
 const n=BigInt(value);if(n<(zero?0n:1n)||n>9223372036854775807n)fail('Identificador inválido');
 return String(n);
}
export function normalizeAssigneeIds(value){
 if(!Array.isArray(value)||value.length>100)fail('Elegí hasta 100 responsables');
 return [...new Set(value.map(v=>identifier(v)))];
}
async function authorize(c,user,allowed=readers){
 if(!user)fail('No autenticado',401);
 if(!allowed.includes(user.role))fail('Tu rol no permite cambiar responsables',403);
 const org=identifier(user.organization_id),person=identifier(user.id);
 // Hold membership and organization against suspension during this transaction.
 const row=(await c.query(`select m.role from organization_members m join organizations o on o.id=m.organization_id
  where m.organization_id=$1 and m.user_id=$2 and m.active and m.removed_at is null and o.active for share of m,o`,[org,person])).rows[0];
 if(!row||!allowed.includes(row.role))fail('Sin acceso activo para esta operación',403);
 return org;
}
async function record(c,kind,key,org){
 const d=definition(kind),r=await owned(c,d.table,identifier(key),org);
 // Verify the entire parent chain, including legacy inconsistent records.
 const project=kind==='projects'?r:await owned(c,'agency_projects',r.project_id,org);
 await owned(c,'agency_clients',project.client_id,org);
 return r;
}
async function snapshot(c,kind,r,org){
 const assignees=(await c.query(`select a.user_id::text as id,a.is_primary,u.email,coalesce(nullif(p.full_name,''),u.email) as full_name
  from agency_record_assignees a join users u on u.id=a.user_id
  left join agency_user_profiles p on p.user_id=a.user_id and p.organization_id=a.organization_id
  where a.organization_id=$1 and a.kind=$2 and a.record_id=$3 order by a.is_primary desc,a.user_id`,[org,kind,r.id])).rows;
 return {assigned_user_id:assignees.find(a=>a.is_primary)?.id??null,assigned_user_ids:assignees.map(a=>a.id),assignee_version:String(r.assignee_version),assignees};
}
// Helpers must use the caller's BEGIN/COMMIT transaction, including record creation.
export async function getRecordAssignees(c,user,kind,key){
 const org=await authorize(c,user);return snapshot(c,kind,await record(c,kind,key,org),org);
}
export async function setRecordAssignees(c,user,kind,key,payload){
 const d=definition(kind),org=await authorize(c,user,d.writers);
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>!['assigned_user_ids','assigned_user_id','expected_version'].includes(k)))fail('Asignación inválida');
 const ids=normalizeAssigneeIds(payload.assigned_user_ids),version=identifier(payload.expected_version,true);
 const r=await record(c,kind,key,org);
 if(String(r.assignee_version)!==version)fail('Los responsables cambiaron. Recargá antes de guardar.',409);
 const primary=Object.hasOwn(payload,'assigned_user_id')?(payload.assigned_user_id===null?null:identifier(payload.assigned_user_id)):(ids.includes(String(r.assigned_user_id))?String(r.assigned_user_id):ids[0]??null);
 if((ids.length>0&&!primary)||(primary&&!ids.includes(primary)))fail('El responsable principal debe estar en la lista');
 const active=(await c.query('select user_id::text as id from organization_members where organization_id=$1 and user_id=any($2::bigint[]) and active and removed_at is null order by user_id for share',[org,ids])).rows;
 if(active.length!==ids.length)fail('Todos los responsables deben tener acceso activo a esta empresa');
 const before=await snapshot(c,kind,r,org);
 const additional=ids.filter(id=>id!==primary);
 const stored=(await c.query(`select user_id::text as id from ${d.links} where organization_id=$1 and ${d.key}=$2`,[org,r.id])).rows;
 if(String(r.assigned_user_id??'')===String(primary??'')&&stored.length===additional.length&&stored.every(row=>additional.includes(row.id)))return before;
 await c.query("select set_config('app.current_user',$1,true)",[String(user.id)]);
 const updated=(await c.query(`update ${d.table} set assigned_user_id=$1,assignee_version=assignee_version+1,updated_at=now() where id=$2 and organization_id=$3 returning *`,[primary,r.id,org])).rows[0];
 await c.query(`delete from ${d.links} where organization_id=$1 and ${d.key}=$2 and not(user_id=any($3::bigint[]))`,[org,r.id,additional]);
 await c.query(`insert into ${d.links}(organization_id,${d.key},user_id) select $1,$2,unnest($3::bigint[]) on conflict do nothing`,[org,r.id,additional]);
 return snapshot(c,kind,updated,org);
}
export async function projectAssignees({req,res,url,db,session,body,send}){
 const match=url.pathname.match(/^\/api\/agency\/(projects|work-orders)\/(\d+)\/assignees$/),people=url.pathname==='/api/agency/assignees';
 if(!match&&!people)return false;
 let c;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  if(!['GET','PATCH'].includes(req.method)||people&&req.method!=='GET')fail('Método no permitido',405);
  c=await db.connect();await c.query('begin');
  await c.query("select set_config('app.current_ip',$1,true)",[req.socket?.remoteAddress||'']);
  let result;
  if(people){
   const org=await authorize(c,user);
   result={members:(await c.query(`select m.user_id::text as id,u.email,coalesce(nullif(p.full_name,''),u.email) as full_name,true as active
    from organization_members m join users u on u.id=m.user_id left join agency_user_profiles p on p.user_id=m.user_id and p.organization_id=m.organization_id
    where m.organization_id=$1 and m.active and m.removed_at is null order by full_name,m.user_id`,[org])).rows};
  }else result=req.method==='GET'?await getRecordAssignees(c,user,match[1],match[2]):await setRecordAssignees(c,user,match[1],match[2],await body(req));
  await c.query('commit');send(res,200,result);
 }catch(e){
  if(c)await c.query('rollback');
  console.error(JSON.stringify({event:'project_assignees_error',status:e.status||500}));
  send(res,e.status||500,{error:e.status?e.message:'No se pudieron actualizar los responsables'});
 }finally{c?.release();}
 return true;
}
