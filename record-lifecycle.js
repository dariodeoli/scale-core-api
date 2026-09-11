import {attributeActors} from './actor-identity.js';
const administrators = ['owner','admin'];
const production = [...administrators,'management','production'];
const commercial = [...administrators,'management','finance','sales'];
export const archiveKinds = {
 clients: {table:'agency_clients',name:'name',roles:[...administrators,'management','sales']},
 projects: {table:'agency_projects',name:'name',roles:production},
 'work-orders': {table:'agency_work_orders',name:'title',roles:production},
 leads: {table:'agency_leads',name:'name',roles:commercial},
 plans: {table:'agency_plans',name:'name',roles:commercial},
 inventory: {table:'agency_inventory',name:'name',roles:[...production,'finance']},
 budgets: {table:'agency_budgets',name:'title',roles:commercial},
 collaborators: {table:'agency_collaborators',name:'full_name',roles:[...administrators,'finance']},
 accounts: {table:'bank_accounts',name:'name',roles:[...administrators,'finance']},
};
export function visibleRecord(alias, kind) {
 if(!/^[a-z_]+$/.test(alias)||!Object.hasOwn(archiveKinds,kind))throw new Error('Invalid archive query');
 return `not exists(select 1 from agency_archived_records ar where ar.organization_id=${alias}.organization_id and ar.kind='${kind}' and ar.record_id=${alias}.id)`;
}
export async function assertRecordAvailable(c,table,row) {
 const entry=Object.entries(archiveKinds).find(([kind,v])=>v.table===table&&kind!=='accounts');
 if(!entry||!row)return;
 const removed=(await c.query('select 1 from agency_archived_records where organization_id=$1 and kind=$2 and record_id=$3',[row.organization_id,entry[0],row.id])).rows.length;
 if(removed)throw Object.assign(new Error('Restaurá este registro desde Papelera antes de usarlo'),{status:409});
 if(table==='agency_projects'||table==='agency_work_orders'){
  const parentTable=table==='agency_projects'?'agency_clients':'agency_projects',parentId=table==='agency_projects'?row.client_id:row.project_id;
  const parent=(await c.query(`select * from ${parentTable} where id=$1 and organization_id=$2`,[parentId,row.organization_id])).rows[0];
  await assertRecordAvailable(c,parentTable,parent);
 }
}
export async function recordLifecycle({req,res,url,db,session,send}) {
 const match=url.pathname.match(/^\/api\/agency\/([a-z-]+)\/(\d+)(\/restore)?$/);
 const trash=url.pathname==='/api/agency/trash'&&req.method==='GET';
 if(!trash&&(!match||(!Object.hasOwn(archiveKinds,match[1])&&match[1]!=='members')||!(req.method==='DELETE'&&!match[3]||req.method==='POST'&&match[3])))return false;
 const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
 let c;
 try {
  const user=await session(req);if(!user)fail('No autenticado',401);
  const allowedKinds=Object.entries(archiveKinds).filter(([,v])=>v.roles.includes(user.role));
  if(trash&&!allowedKinds.length||match&&!(match[1]==='members'?administrators:archiveKinds[match[1]].roles).includes(user.role))fail('Tu rol no permite eliminar o restaurar este registro',403);
  c=await db.connect();await c.query('begin');
  await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);
  const org=user.organization_id;
  if(trash){
   const queries=allowedKinds.map(([kind,v])=>`select '${kind}' as kind,r.id::text as id,r.${v.name} as name,a.removed_at,a.removed_by from ${v.table} r join agency_archived_records a on a.organization_id=r.organization_id and a.record_id=r.id and a.kind='${kind}' where r.organization_id=$1`);
   const records=(await c.query(queries.join(' union all ')+' order by removed_at desc',[org])).rows;
   await attributeActors(c,org,[{rows:records,userId:'removed_by'}]);
   await c.query('commit');send(res,200,{records});return true;
  }
  const [,kind,rawKey,restore]=match,key=String(BigInt(rawKey));
  if(kind==='members'){
   if(restore)fail('Para devolver acceso, enviá una nueva invitación desde Equipo');
   await c.query('select id from organizations where id=$1 for update',[org]);
   const member=(await c.query('select * from organization_members where organization_id=$1 and user_id=$2 for update',[org,key])).rows[0];
   if(!member)fail('Integrante no encontrado',404);
   if(String(user.id)===key)fail('No podés quitar tu propio acceso');
   if(member.role==='owner'){
    if(user.role!=='owner')fail('Solo un dueño puede quitar a otro dueño',403);
    const owners=(await c.query("select count(*)::int as total from organization_members where organization_id=$1 and role='owner' and active=true and user_id<>$2",[org,key])).rows[0].total;
    if(!owners)fail('Debe quedar al menos un dueño activo');
   }
   await c.query('update organization_members set active=false,removed_at=coalesce(removed_at,now()) where organization_id=$1 and user_id=$2',[org,key]);
   await c.query('delete from sessions where organization_id=$1 and user_id=$2',[org,key]);
  }else{
   const definition=archiveKinds[kind];
   const record=(await c.query(`select * from ${definition.table} where id=$1 and organization_id=$2 for update`,[key,org])).rows[0];
   if(!record)fail('Registro no encontrado',404);
   if(restore){
    const removed=await c.query('delete from agency_archived_records where organization_id=$1 and kind=$2 and record_id=$3 returning record_id',[org,kind,key]);
    if(kind==='accounts'&&removed.rows.length)await c.query('update bank_accounts set active=true,updated_at=now() where id=$1 and organization_id=$2',[key,org]);
   }else{
    if(kind==='accounts'&&Number(record.balance)!==0)fail('La cuenta tiene saldo. Transferilo o conciliá sus movimientos antes de retirarla.');
    if(kind==='accounts')await c.query('update bank_accounts set active=false,updated_at=now() where id=$1 and organization_id=$2',[key,org]);
    if(kind==='budgets')await c.query('update agency_budgets set share_enabled=false where id=$1 and organization_id=$2',[key,org]);
    await c.query('insert into agency_archived_records(organization_id,kind,record_id,removed_by) values($1,$2,$3,$4) on conflict do nothing',[org,kind,key,user.id]);
   }
  }
  await c.query('commit');send(res,200,{ok:true});
 }catch(error){if(c)await c.query('rollback');console.error(JSON.stringify({event:'record_lifecycle_error',status:error.status||500,code:error.code}));send(res,error.status||500,{error:error.status?error.message:'No se pudo completar la operación'});}
 finally{c?.release();}
 return true;
}
