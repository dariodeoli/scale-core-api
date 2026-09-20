import {attributeActors} from './actor-identity.js';
import {roleCan} from './permissions.js';
import {fail,text,amount,date,option,serial} from './suite-validation.js';
import {profilePhoto} from './media-policy.js';
import {visibleRecord} from './record-lifecycle.js';
import {currencies} from './currencies.js';
import {companyCurrency} from './forecast.js';




const identifier=value=>{
 if(!['string','number'].includes(typeof value)||!/^\d{1,19}$/.test(String(value))||typeof value==='number'&&!Number.isSafeInteger(value))fail('Identificador inválido');
 const n=BigInt(value);if(n<=0n||n>=9223372036854775807n)fail('Identificador inválido');return String(n);
};
const optionalId=value=>value===null||value===undefined||value===''?null:identifier(value);
const categoryIcons=['camera','video','mic','lamp','lightbulb','monitor','laptop','speaker','hard-drive','battery-charging','package','home'];
const inventoryPayload=row=>({...row,barcode_payload:`SCALE-INVENTORY:${row.inventory_code}`});
const storageLocationName=value=>text(value||'',100);
function identifiers(values,label,max=50){
 if(!Array.isArray(values)||!values.length||values.length>max)fail(`Elegí entre 1 y ${max} ${label}`);
 const ids=values.map(identifier);if(new Set(ids).size!==ids.length)fail(`No repitas ${label}`);
 return ids.sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
}
export function inventoryTimestamp(value){
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/.test(value))fail('Ingresá fecha y hora con zona horaria');
 const parsed=new Date(value);if(!Number.isFinite(parsed.getTime()))fail('Fecha u hora inválida');
 // Reject calendar overflow (e.g. February 30), independently of the offset.
 const day=value.slice(0,10);date(day);
 return parsed.toISOString();
}
const version=(value,current)=>{if(!Number.isInteger(value)||value!==current)fail('La reserva cambió. Recargá antes de guardar.',409);};

async function authorize(c,user,capability,write){
 if(!roleCan(user,capability))fail('Tu rol no permite esta operación',403);
 const org=identifier(user.organization_id);
 // All inventory mutations take this first, then membership/items in fixed order.
 // READ COMMITTED + a separate overlap query sees the previous committed writer.
 const company=(await c.query(`select id from organizations where id=$1 and active ${write?'for update':'for share'}`,[org])).rows[0];
 if(!company)fail('Sin acceso a esta empresa',403);
 const membership=(await c.query('select role from organization_members where organization_id=$1 and user_id=$2 and active and removed_at is null for share',[org,identifier(user.id)])).rows[0];
 // Check both session role (including demo preview) and current membership.
 if(!membership||!roleCan({role:membership.role,capabilities:user.capabilities},capability))fail('Sin acceso activo para esta operación',403);
 return org;
}
async function activeMembers(c,org,ids){
 const rows=(await c.query('select user_id::text as id from organization_members where organization_id=$1 and user_id=any($2::bigint[]) and active and removed_at is null order by user_id for share',[org,ids])).rows;
 if(rows.length!==ids.length)fail('Los responsables deben tener acceso activo a esta empresa');
}
async function activeProject(c,org,key){
 const project=(await c.query(`select p.* from agency_projects p join agency_clients a on a.id=p.client_id and a.organization_id=p.organization_id
  where p.id=$1 and p.organization_id=$2 and p.status='active' and a.active and ${visibleRecord('p','projects')} and ${visibleRecord('a','clients')} for share of p,a`,[key,org])).rows[0];
 if(!project)fail('Elegí un proyecto activo de esta empresa');return project;
}
async function equipment(c,org,ids){
 const rows=(await c.query(`select i.* from agency_inventory i where i.organization_id=$1 and i.id=any($2::bigint[]) and ${visibleRecord('i','inventory')} order by i.id for update`,[org,ids])).rows;
 if(rows.length!==ids.length)fail('Uno o más equipos no están disponibles en esta empresa');return rows;
}
async function traceInventory(c,org,ids,eventType,actor,reservationId=null,context={}){
 for(const id of ids)await c.query('insert into agency_inventory_trace(organization_id,inventory_id,reservation_id,event_type,actor_user_id,context) values($1,$2,$3,$4,$5,$6::jsonb)',[org,id,reservationId,eventType,actor,JSON.stringify(context)]);
}
async function reservation(c,org,key){
 const row=(await c.query('select * from agency_inventory_reservations where id=$1 and organization_id=$2 for update',[key,org])).rows[0];
 if(!row)fail('Reserva no encontrada',404);return row;
}
function ownReservation(user,row){if(user.role==='viewer')fail('Tu rol es de solo lectura',403);if(!roleCan(user,'inventory.manage')&&String(row.created_by_user_id)!==String(user.id))fail('Solo podés gestionar tus propias reservas',403);}

// Linear depreciation and current value are computed on read from the stored
// purchase inputs; no parallel value history is written.
const depotComputed=`case when i.purchase_value is null then null
  when i.depreciation_method='linear' and i.useful_life_months>0 and i.purchase_date is not null
   then round(i.purchase_value-least(round((i.purchase_value-coalesce(i.residual_value,0))*least(el.months,i.useful_life_months)/i.useful_life_months,2),i.purchase_value-coalesce(i.residual_value,0)),2)
  else i.purchase_value end as current_value,
 case when i.purchase_value is null then null
  when i.depreciation_method='linear' and i.useful_life_months>0 and i.purchase_date is not null
   then least(round((i.purchase_value-coalesce(i.residual_value,0))*least(el.months,i.useful_life_months)/i.useful_life_months,2),i.purchase_value-coalesce(i.residual_value,0))
  else 0.00 end as accumulated_depreciation,
 case when i.purchase_value is not null and i.depreciation_method='linear' and i.useful_life_months>0
  then round((i.purchase_value-coalesce(i.residual_value,0))/i.useful_life_months,2) else null end as monthly_depreciation`;
const inventorySelect=`select i.*,cat.name as category_name,cat.active as category_active,cat.icon as category_icon,loc.name as storage_location_name,loc.active as storage_location_active,
  live.id as active_reservation_id,live.title as production_name,p.name as project_name,
  live.custodian_user_id as current_custodian_user_id,coalesce(nullif(up.full_name,''),u.email) as current_custodian_name,
  live.return_user_id,coalesce(nullif(rp.full_name,''),ru.email) as return_user_name,live.ends_at as expected_return_at,
  case when live.id is not null then 'checked_out' when i.status='in_use' then 'legacy_in_use' else 'storage' end as location_type,
  coalesce(nullif(vp.full_name,''),vu.email) as last_verifier_name,vp.photo_url as last_verifier_photo_url,${depotComputed}
  from agency_inventory i left join agency_inventory_categories cat on cat.id=i.category_id and cat.organization_id=i.organization_id
  left join agency_inventory_storage_locations loc on loc.id=i.storage_location_id and loc.organization_id=i.organization_id
  left join agency_inventory_reservation_items ri on ri.inventory_id=i.id and ri.organization_id=i.organization_id and ri.status='checked_out'
  left join agency_inventory_reservations live on live.id=ri.reservation_id and live.organization_id=i.organization_id
  left join agency_projects p on p.id=live.project_id and p.organization_id=i.organization_id
  left join users u on u.id=coalesce(live.custodian_user_id,i.custodian_user_id)
  left join agency_user_profiles up on up.user_id=u.id and up.organization_id=i.organization_id
  left join users ru on ru.id=live.return_user_id
  left join agency_user_profiles rp on rp.user_id=ru.id and rp.organization_id=i.organization_id
  left join users vu on vu.id=i.last_verified_by_user_id
  left join agency_user_profiles vp on vp.user_id=vu.id and vp.organization_id=i.organization_id
  left join lateral (select greatest((extract(year from age(current_date,i.purchase_date))*12+extract(month from age(current_date,i.purchase_date)))::int,0) as months) el on i.purchase_date is not null
  where i.organization_id=$1`;
async function catalog(c,org){
 return (await c.query(`${inventorySelect} and ${visibleRecord('i','inventory')} order by i.name,i.id`,[org])).rows.map(inventoryPayload);
}
async function inventoryRecord(c,org,key){
 const row=(await c.query(`${inventorySelect} and i.id=$2`,[org,key])).rows[0];
 return row?inventoryPayload(row):null;
}
async function maintenanceHistory(c,org,key=null){
 return (await c.query(`select m.*,i.inventory_code,i.name as inventory_name,
  coalesce(nullif(p.full_name,''),u.email) as responsible_name,p.photo_url as responsible_photo_url,
  coalesce(nullif(vp.full_name,''),vu.email) as voided_by_name
  from agency_inventory_maintenance m join agency_inventory i on i.id=m.inventory_id and i.organization_id=m.organization_id
  left join users u on u.id=m.responsible_user_id left join agency_user_profiles p on p.user_id=u.id and p.organization_id=m.organization_id
  left join users vu on vu.id=m.voided_by_user_id left join agency_user_profiles vp on vp.user_id=vu.id and vp.organization_id=m.organization_id
  where m.organization_id=$1 and ($2::bigint is null or m.inventory_id=$2)
  order by m.maintenance_date desc,m.id desc limit 100`,[org,key])).rows;
}
async function saveMaintenance(c,user,org,key,payload){
 const old=key?(await c.query('select * from agency_inventory_maintenance where id=$1 and organization_id=$2 for update',[key,org])).rows[0]:null;
 if(key&&!old)fail('Mantenimiento no encontrado',404);
 if(old?.voided_at)fail('Este mantenimiento ya fue anulado',409);
 const b=payload;
 const inventoryId=identifier(Object.hasOwn(b,'inventory_id')?b.inventory_id:old?.inventory_id);
 const item=(await equipment(c,org,[inventoryId]))[0];
 const when=date(Object.hasOwn(b,'maintenance_date')?b.maintenance_date:old?.maintenance_date);
 if(!when)fail('Indicá la fecha del mantenimiento');
 const kind=text(b.kind??old?.kind,80);if(kind.length<2)fail('Indicá el tipo de mantenimiento');
 const description=text(b.description??old?.description??'',2000);
 const cost=amount(b.cost??old?.cost??0);
 const currency=option(b.currency===undefined?old?.currency??await companyCurrency(c,org):b.currency,currencies);
 const responsible=Object.hasOwn(b,'responsible_user_id')?optionalId(b.responsible_user_id):old?.responsible_user_id??null;
 if(responsible)await activeMembers(c,org,[responsible]);
 const row=old
  ?(await c.query('update agency_inventory_maintenance set maintenance_date=$1,kind=$2,description=$3,cost=$4,currency=$5,responsible_user_id=$6,updated_at=now() where id=$7 and organization_id=$8 returning *',[when,kind,description,cost,currency,responsible,key,org])).rows[0]
  :(await c.query('insert into agency_inventory_maintenance(organization_id,inventory_id,maintenance_date,kind,description,cost,currency,responsible_user_id,created_by_user_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[org,item.id,when,kind,description,cost,currency,responsible,user.id])).rows[0];
 return row;
}
async function voidMaintenance(c,user,org,key){
 const row=(await c.query('select * from agency_inventory_maintenance where id=$1 and organization_id=$2 for update',[key,org])).rows[0];
 if(!row)fail('Mantenimiento no encontrado',404);
 if(row.voided_at)fail('Este mantenimiento ya fue anulado',409);
 await c.query('update agency_inventory_maintenance set voided_at=now(),voided_by_user_id=$1,updated_at=now() where id=$2 and organization_id=$3',[user.id,key,org]);
 return {ok:true};
}
async function listReservations(c,org,from,to,key=null){
 return (await c.query(`select r.*,p.name as project_name,
  coalesce(nullif(rp.full_name,''),ru.email) as return_user_name,
  coalesce(nullif(cp.full_name,''),cu.email) as custodian_name,
  coalesce((select jsonb_agg(jsonb_build_object('id',i.id::text,'name',i.name,'inventory_code',i.inventory_code,'storage_location_id',i.storage_location_id::text,'storage_location_name',loc.name,'storage_shelf',i.storage_shelf,'storage_row',i.storage_row) order by i.name)
   from agency_inventory_reservation_items ri join agency_inventory i on i.id=ri.inventory_id and i.organization_id=ri.organization_id left join agency_inventory_storage_locations loc on loc.id=i.storage_location_id and loc.organization_id=i.organization_id where ri.reservation_id=r.id and ri.organization_id=r.organization_id),'[]') as items,
  coalesce((select jsonb_agg(jsonb_build_object('id',m.user_id::text,'name',coalesce(nullif(up.full_name,''),u.email)) order by m.user_id)
   from agency_inventory_reservation_members m join users u on u.id=m.user_id left join agency_user_profiles up on up.user_id=m.user_id and up.organization_id=m.organization_id where m.reservation_id=r.id and m.organization_id=r.organization_id),'[]') as responsible_members
  from agency_inventory_reservations r join agency_projects p on p.id=r.project_id and p.organization_id=r.organization_id
  join users ru on ru.id=r.return_user_id left join agency_user_profiles rp on rp.user_id=ru.id and rp.organization_id=r.organization_id
  left join users cu on cu.id=r.custodian_user_id left join agency_user_profiles cp on cp.user_id=cu.id and cp.organization_id=r.organization_id
  where r.organization_id=$1 and ($4::bigint is null or r.id=$4)
   and ($4::bigint is not null or (r.starts_at<$3::timestamptz and r.ends_at>$2::timestamptz) or r.status='checked_out')
  order by r.starts_at,r.id`,[org,from,to,key])).rows;
}
async function saveReservation(c,user,org,payload,key){
 const old=key?await reservation(c,org,key):null;
 if(old){ownReservation(user,old);if(old.status!=='reserved')fail('Solo se pueden editar reservas sin retirar',409);version(payload.expected_version,old.version);}
 const itemIds=identifiers(payload.inventory_ids,'equipos'),members=identifiers(payload.responsible_user_ids,'responsables',30);
 const returnId=identifier(payload.return_user_id),project=identifier(payload.project_id),title=text(payload.title,160);
 if(title.length<2)fail('Nombrá la producción o el uso previsto');
 if(!members.includes(returnId))fail('La persona que devuelve debe estar entre los responsables');
 if(user.role==='production'&&!members.includes(String(user.id)))fail('Incluite entre los responsables de tu reserva');
 const start=inventoryTimestamp(payload.starts_at),end=inventoryTimestamp(payload.ends_at);
 if(end<=start||new Date(end)-new Date(start)>366*86400000)fail('El fin debe ser posterior al inicio, dentro de 366 días');
 await activeProject(c,org,project);await activeMembers(c,org,members);
 const rows=await equipment(c,org,itemIds);
 if(rows.some(row=>['maintenance','retired'].includes(row.status)))fail('Hay equipos en mantenimiento o dados de baja');
 const conflict=(await c.query(`select 1 from agency_inventory_reservation_items where organization_id=$1 and inventory_id=any($2::bigint[]) and reservation_id<>coalesce($5::bigint,0)
  and status in ('reserved','checked_out') and starts_at<$4::timestamptz and ends_at>$3::timestamptz limit 1`,[org,itemIds,start,end,key])).rows.length;
 if(conflict)fail('Hay equipos reservados en ese horario. Cambiá las fechas o la selección.',409);
 let saved;
 if(old){
  await c.query('delete from agency_inventory_reservation_items where reservation_id=$1 and organization_id=$2',[key,org]);
  await c.query('delete from agency_inventory_reservation_members where reservation_id=$1 and organization_id=$2',[key,org]);
  saved=(await c.query('update agency_inventory_reservations set project_id=$1,title=$2,starts_at=$3,ends_at=$4,return_user_id=$5,notes=$6,version=version+1,updated_at=now() where id=$7 and organization_id=$8 returning *',[project,title,start,end,returnId,text(payload.notes||''),key,org])).rows[0];
 }else saved=(await c.query('insert into agency_inventory_reservations(organization_id,project_id,title,starts_at,ends_at,created_by_user_id,return_user_id,notes) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[org,project,title,start,end,user.id,returnId,text(payload.notes||'')])).rows[0];
 for(const person of members)await c.query('insert into agency_inventory_reservation_members(organization_id,reservation_id,user_id) values($1,$2,$3)',[org,saved.id,person]);
 for(const item of itemIds)await c.query('insert into agency_inventory_reservation_items(organization_id,reservation_id,inventory_id) values($1,$2,$3)',[org,saved.id,item]);
 await traceInventory(c,org,itemIds,old?'reservation.updated':'reservation.reserved',user.id,saved.id,{project_id:String(project),title,starts_at:start,ends_at:end,responsible_user_ids:members,return_user_id:returnId,notes:text(payload.notes||'')});
 return (await listReservations(c,org,start,end,saved.id))[0];
}
async function transition(c,user,org,key,action,payload){
 const row=await reservation(c,org,key);
 const assignedReturn=action==='return'&&roleCan(user,'inventory.book')&&[row.return_user_id,row.custodian_user_id].some(id=>String(id)===String(user.id));
 if(!assignedReturn)ownReservation(user,row);
 const target={checkout:'checked_out',return:'returned',cancel:'cancelled'}[action];
 if(row.status===target)return {reservation:(await listReservations(c,org,null,null,key))[0],alreadyRecorded:true};
 version(payload.expected_version,row.version);
 if(action==='checkout'){
  if(row.status!=='reserved')fail('Solo se retiran equipos de una reserva pendiente',409);
  const now=(await c.query('select now() as now')).rows[0].now;
  if(new Date(now)<new Date(row.starts_at)||new Date(now)>=new Date(row.ends_at))fail('El retiro debe registrarse dentro del horario reservado. Ajustá las fechas antes de retirar.',409);
  await activeProject(c,org,row.project_id);
  const members=(await c.query('select user_id::text as id from agency_inventory_reservation_members where reservation_id=$1 and organization_id=$2',[key,org])).rows.map(r=>r.id);
  await activeMembers(c,org,members);
  const custodian=identifier(payload.custodian_user_id);
  if(!members.includes(custodian))fail('Elegí al custodio entre los responsables de la reserva');
  const ids=(await c.query('select inventory_id::text as id from agency_inventory_reservation_items where reservation_id=$1 and organization_id=$2',[key,org])).rows.map(r=>r.id);
  const rows=await equipment(c,org,ids);
  if(!ids.length||rows.some(r=>r.status!=='available'))fail('Hay equipos sin devolver o no disponibles. Registrá su devolución antes de retirarlos.',409);
  const note=text(payload.note||'',2000);
  await c.query("update agency_inventory_reservations set status='checked_out',custodian_user_id=$1,checked_out_at=now(),checked_out_by_user_id=$2,checkout_note=$3,version=version+1,updated_at=now() where id=$4 and organization_id=$5",[custodian,user.id,note,key,org]);
  await c.query("update agency_inventory set status='in_use',custodian_user_id=$1 where organization_id=$2 and id=any($3::bigint[])",[custodian,org,ids]);
  await traceInventory(c,org,ids,'loan.checked_out',user.id,key,{project_id:String(row.project_id),title:row.title,responsible_user_ids:members,custodian_user_id:custodian,note});
 }else if(action==='return'){
  if(row.status!=='checked_out')fail('Primero registrá el retiro',409);
  const ids=(await c.query('select inventory_id::text as id from agency_inventory_reservation_items where reservation_id=$1 and organization_id=$2',[key,org])).rows.map(r=>r.id);
  const locations=payload.locations;
  if(!Array.isArray(locations)||locations.length!==ids.length)fail('Indicá dónde queda cada equipo devuelto');
  const seen=new Set();
  for(const location of locations){
   if(!location||typeof location!=='object'||Array.isArray(location))fail('Indicá una ubicación válida para cada equipo');
   const id=identifier(location.inventory_id);if(!ids.includes(id)||seen.has(id))fail('La devolución debe incluir cada equipo una sola vez');seen.add(id);
   const locationId=location.storage_location_id;
   if((locationId===null||locationId===undefined||locationId===''||locationId==='new'||locationId==='custom')&&!storageLocationName(location.storage_location_name??location.storage_shelf))fail('Indicá el estante o lugar de guardado de cada equipo');
   text(location.storage_row||'',80);option(location.status||'available',['available','maintenance']);
  }
  // Returns remain possible when a project ended or an assignee was suspended.
  const note=text(payload.note||'',2000);
  await c.query("update agency_inventory_reservations set status='returned',returned_at=now(),returned_by_user_id=$1,return_note=$2,version=version+1,updated_at=now() where id=$3 and organization_id=$4",[user.id,note,key,org]);
  for(const location of locations){
   const oldItem=(await equipment(c,org,[location.inventory_id]))[0];
   const place=await storageLocation(c,org,oldItem,location,oldItem.id);
   await c.query('update agency_inventory set status=$1,custodian_user_id=null,storage_location_id=$2,storage_shelf=$3,storage_row=$4 where id=$5 and organization_id=$6',[location.status||'available',place.id,place.shelf,text(location.storage_row||'',80),location.inventory_id,org]);
  }
  await traceInventory(c,org,ids,'loan.checked_in',user.id,key,{project_id:String(row.project_id),title:row.title,locations,note});
 }else{
  if(row.status!=='reserved')fail('Una reserva retirada se cierra registrando la devolución',409);
  await c.query("update agency_inventory_reservations set status='cancelled',cancelled_at=now(),version=version+1,updated_at=now() where id=$1 and organization_id=$2",[key,org]);
  const ids=(await c.query('select inventory_id::text as id from agency_inventory_reservation_items where reservation_id=$1 and organization_id=$2',[key,org])).rows.map(r=>r.id);
  await traceInventory(c,org,ids,'reservation.cancelled',user.id,key,{project_id:String(row.project_id),title:row.title});
 }
 return {reservation:(await listReservations(c,org,null,null,key))[0]};
}

async function storageLocation(c,org,old,payload,key=null){
 const supplied=Object.hasOwn(payload,'storage_location_id');
 const candidate=supplied?payload.storage_location_id:old.storage_location_id;
 const customName=storageLocationName(payload.storage_location_name??payload.storage_shelf);
 if(candidate==='new'){
  if(!customName)fail('Ingresá el nombre del nuevo lugar de guardado');
  let row=(await c.query('select * from agency_inventory_storage_locations where organization_id=$1 and lower(trim(name))=lower($2) for update',[org,customName])).rows[0];
  if(row&&!row.active)fail('Ese lugar está archivado. Reactivalo antes de usarlo.',409);
  if(!row)row=(await c.query('insert into agency_inventory_storage_locations(organization_id,name) values($1,$2) returning *',[org,customName])).rows[0];
  return {id:String(row.id),shelf:row.name};
 }
 if(candidate==='custom'){
  if(!customName)fail('Ingresá la ubicación personalizada');
  return {id:null,shelf:customName};
 }
 if(candidate===null||candidate===undefined||candidate==='')return {id:null,shelf:Object.hasOwn(payload,'storage_shelf')?text(payload.storage_shelf,100):(old.storage_shelf??'')};
 const row=(await c.query('select * from agency_inventory_storage_locations where id=$1 and organization_id=$2',[identifier(candidate),org])).rows[0];
 if(!row)fail('Lugar de guardado no encontrado',404);
 if(!row.active&&(String(row.id)!==String(old.storage_location_id)||!key))fail('Elegí un lugar de guardado activo');
 return {id:String(row.id),shelf:row.name};
}
async function listStorageLocations(c,org){
 return (await c.query(`select l.*,count(i.id)::int as item_count,
  (select coalesce(nullif(p.full_name,''),u.email) from organization_person_identity p join users u on u.id=p.user_id where p.user_id=l.responsible_user_id and p.organization_id=l.organization_id) as responsible_name,
  (select p.photo_url from organization_person_identity p where p.user_id=l.responsible_user_id and p.organization_id=l.organization_id) as responsible_photo_url
  from agency_inventory_storage_locations l left join agency_inventory i on i.storage_location_id=l.id and i.organization_id=l.organization_id
  where l.organization_id=$1 group by l.id order by l.active desc,l.name`,[org])).rows;
}

async function saveItem(c,user,org,key,payload){
 const old=key?(await equipment(c,org,[key]))[0]:{};
 const sent=field=>Object.hasOwn(payload,field);
 // Un PATCH solo revalida el campo que llega: lo guardado viaja tal cual para no
 // romper filas legacy cargadas antes de los límites o reglas actuales.
 const name=sent('name')?text(payload.name,160):old.name;
 if(!name||name.length<2)fail('Ingresá el nombre del equipo');
 let category;
 if(sent('category_id')||!sent('category')&&old.category_id){
  category=(await c.query('select * from agency_inventory_categories where id=$1 and organization_id=$2',[identifier(sent('category_id')?payload.category_id:old.category_id),org])).rows[0];
 }else{
  const rawCategory=sent('category')?payload.category||'Otro':old.category||'Otro';
  if(!sent('category')&&typeof rawCategory==='string'&&rawCategory.length>80){
   // Categoría legacy por encima del límite actual: viaja tal cual, sin resolver ficha.
   category={id:old.category_id??null,name:rawCategory};
  }else{
   const categoryName=text(rawCategory,80);
   if(!categoryName)fail('Ingresá el nombre de la categoría');
   category=(await c.query('select * from agency_inventory_categories where organization_id=$1 and lower(trim(name))=lower($2)',[org,categoryName])).rows[0];
   if(!category)category=(await c.query('insert into agency_inventory_categories(organization_id,name) values($1,$2) returning *',[org,categoryName])).rows[0];
  }
 }
 if(!category||!category.active&&String(category.id)!==String(old.category_id))fail('Elegí una categoría activa de esta empresa');
 const status=sent('status')?option(payload.status,['available','in_use','maintenance','retired']):old.status||'available';
 if(status==='in_use'&&old.status!=='in_use')fail('Usá Registrar retiro para indicar quién lleva el equipo');
 const custodian=sent('custodian_user_id')?optionalId(payload.custodian_user_id):old.custodian_user_id??null;
 // Solo se valida la pertenencia cuando el PATCH envía un custodio nuevo.
 if(sent('custodian_user_id')&&custodian)await activeMembers(c,org,[custodian]);
 const location=await storageLocation(c,org,old,payload,key);const shelf=location.shelf,storageRow=sent('storage_row')?text(payload.storage_row,80):old.storage_row??'';
 const photo=Object.hasOwn(payload,'photo_url')?await profilePhoto(payload.photo_url):old.photo_url||null;
 const locationChanged=String(location.id||'')!==String(old.storage_location_id||'')||shelf!==(old.storage_shelf||'');
 if(key){
  const open=(await c.query("select status from agency_inventory_reservation_items where inventory_id=$1 and organization_id=$2 and status in ('reserved','checked_out')",[key,org])).rows;
  if(open.length&&status!==old.status)fail('Cerrá o cancelá las reservas antes de cambiar el estado del equipo',409);
  if(open.some(row=>row.status==='checked_out')&&(String(custodian??'')!==String(old.custodian_user_id??'')||locationChanged))fail('La ubicación y el custodio se cambian al registrar la devolución',409);
 }
 // El código de inventario es estable: cualquier diferencia se rechaza sin revalidar el guardado.
 if(key&&sent('inventory_code')&&String(payload.inventory_code??'')!==String(old.inventory_code??''))fail('El código de inventario es estable y no se puede cambiar',409);
 const code=key?old.inventory_code:text(payload.inventory_code||'',60);
 const purchaseValue=sent('purchase_value')?(payload.purchase_value===null||payload.purchase_value===''?null:amount(payload.purchase_value)):(old.purchase_value===undefined||old.purchase_value===null?null:Number(old.purchase_value));
 const purchaseDate=sent('purchase_date')?date(payload.purchase_date):date(old.purchase_date);
 const depreciationMethod=option(sent('depreciation_method')?payload.depreciation_method:old.depreciation_method||'none',['none','linear']);
 const lifeInput=sent('useful_life_months')?payload.useful_life_months:old.useful_life_months??null;
 const usefulLife=lifeInput===null||lifeInput===undefined||lifeInput===''?null:Number(lifeInput);
 if(usefulLife!==null&&(!Number.isInteger(usefulLife)||usefulLife<1||usefulLife>600))fail('La vida útil debe estar entre 1 y 600 meses');
 const residual=sent('residual_value')?(payload.residual_value===null||payload.residual_value===''?0:amount(payload.residual_value)):(old.residual_value===undefined?0:Number(old.residual_value||0));
 // Las reglas cruzadas del valor solo aplican al alta o cuando el borrador toca alguno de esos campos.
 if(!key||['purchase_value','purchase_date','depreciation_method','useful_life_months','residual_value'].some(sent)){
  if(purchaseValue===null&&residual>0)fail('Cargá primero el valor de compra');
  if(purchaseValue!==null&&Math.round(residual*100)>Math.round(purchaseValue*100))fail('El valor residual no puede superar el valor de compra');
  if(depreciationMethod==='linear'&&(purchaseValue===null||!purchaseDate||usefulLife===null))fail('Para depreciación lineal indicá valor de compra, fecha y vida útil');
 }
 const values=[name,category.name,sent('serial_number')?serial(payload.serial_number||''):old.serial_number??'',custodian,sent('value')?amount(payload.value):old.value??0,sent('currency')?option(payload.currency,currencies):old.currency??await companyCurrency(c,org),status,sent('acquired_on')?date(payload.acquired_on):old.acquired_on??null,sent('notes')?text(payload.notes||''):old.notes??'',category.id,location.id,shelf,storageRow,code,photo,purchaseValue,purchaseDate,depreciationMethod,usefulLife,residual,org];
 const result=key?await c.query(`update agency_inventory set name=$1,category=$2,serial_number=$3,custodian_user_id=$4,value=$5,currency=$6,status=$7,acquired_on=$8,notes=$9,category_id=$10,storage_location_id=$11,storage_shelf=$12,storage_row=$13,inventory_code=$14,photo_url=$15,purchase_value=$16,purchase_date=$17,depreciation_method=$18,useful_life_months=$19,residual_value=$20${locationChanged?',location_changed_at=now()':''} where organization_id=$21 and id=$22 returning *`,[...values,key]):await c.query('insert into agency_inventory(name,category,serial_number,custodian_user_id,value,currency,status,acquired_on,notes,category_id,storage_location_id,storage_shelf,storage_row,inventory_code,photo_url,purchase_value,purchase_date,depreciation_method,useful_life_months,residual_value,organization_id,location_changed_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,now()) returning *',values);
 const saved=(await inventoryRecord(c,org,String(result.rows[0].id)))||inventoryPayload(result.rows[0]);
 await traceInventory(c,org,[String(saved.id)],key?'inventory.updated':'inventory.created',user.id,null,{inventory_code:saved.inventory_code,name:saved.name,status:saved.status});
 if(key&&locationChanged)await traceInventory(c,org,[String(saved.id)],'location.changed',user.id,null,{inventory_code:saved.inventory_code,from_shelf:old.storage_shelf||null,to_shelf:shelf,storage_location_id:location.id});
 return saved;
}

async function verifyItem(c,user,org,key,payload){
 const item=(await equipment(c,org,[key]))[0];
 const result=option(payload.result,['confirmed','difference','missing']);
 const counted=payload.counted_quantity===undefined?(result==='missing'?0:1):payload.counted_quantity;
 if(!Number.isInteger(counted)||counted<0||counted>1)fail('La cantidad contada debe ser 0 o 1 para este activo físico');
 if(result==='missing'&&counted!==0||result==='confirmed'&&counted!==1)fail('La cantidad contada no coincide con el resultado de la verificación');
 const differences=text(payload.differences||'',2000),note=text(payload.note||'',2000);
 if(['difference','missing'].includes(result)&&!differences)fail('Describí la diferencia encontrada');
 const adjustment=payload.adjustment;
 if(adjustment!==undefined&&(typeof adjustment!=='object'||!adjustment||Array.isArray(adjustment)))fail('El ajuste de inventario es inválido');
 const open=(await c.query("select 1 from agency_inventory_reservation_items where organization_id=$1 and inventory_id=$2 and status in ('reserved','checked_out') limit 1",[org,key])).rows.length>0;
 if(adjustment&&open)fail('No se ajusta un equipo con reserva abierta; registrá retiro, devolución o cancelación primero.',409);
 let after=item,adjusted=false;
 if(adjustment){
  const status=adjustment.status===undefined?item.status:option(adjustment.status,['available','maintenance','retired']);
  const shelf=adjustment.storage_shelf===undefined?item.storage_shelf:text(adjustment.storage_shelf,100);
  const row=adjustment.storage_row===undefined?item.storage_row:text(adjustment.storage_row,80);
  adjusted=status!==item.status||shelf!==item.storage_shelf||row!==item.storage_row;
  if(adjusted)after=(await c.query('update agency_inventory set status=$1,storage_shelf=$2,storage_row=$3,custodian_user_id=null where id=$4 and organization_id=$5 returning *',[status,shelf,row,key,org])).rows[0];
 }
 const verified=(await c.query('update agency_inventory set last_verified_at=now(),last_verified_by_user_id=$1,last_verification_result=$2,last_verification_differences=$3,last_verified_counted_quantity=$4 where id=$5 and organization_id=$6 returning *',[user.id,result,differences,counted,key,org])).rows[0];
 const verification=(await c.query('insert into agency_inventory_verifications(organization_id,inventory_id,verified_by_user_id,result,counted_quantity,differences,note,adjusted,before_state,after_state) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb) returning *',[org,key,user.id,result,counted,differences,note,adjusted,JSON.stringify(item),JSON.stringify({...after,...verified})])).rows[0];
 await traceInventory(c,org,[key],'stock.verified',user.id,null,{inventory_code:item.inventory_code,result,counted_quantity:counted,differences,note,adjusted});
 return {record:await inventoryRecord(c,org,key)||inventoryPayload(verified),verification};
}

async function batchItems(c,user,org,payload){
 const ids=[...new Set((Array.isArray(payload.ids)?payload.ids:[]).map(value=>identifier(value)))];
 if(!ids.length||ids.length>50)fail('Elegí entre 1 y 50 equipos');
 const change=payload.change&&typeof payload.change==='object'&&!Array.isArray(payload.change)?payload.change:fail('Cambio inválido');
 const verify=change.verify===true,location=change.location;
 if(!verify&&location===undefined)fail('Indicá qué cambiar en los equipos seleccionados');
 if(location!==undefined&&(typeof location!=='object'||!location||Array.isArray(location)))fail('Ubicación inválida');
 const rows=(await c.query('select id from agency_inventory where organization_id=$1 and id = any($2::bigint[]) order by id for update',[org,ids])).rows;
 if(rows.length!==ids.length)fail('Algún equipo no pertenece a esta empresa',404);
 // A checked-out unit travels with its custodian: its landing place is fixed when
 // the return is registered, exactly like the single-equipment edit enforces.
 if(location!==undefined&&(await c.query("select 1 from agency_inventory_reservation_items where organization_id=$1 and inventory_id=any($2::bigint[]) and status='checked_out' limit 1",[org,ids])).rows.length)fail('La ubicación y el custodio se cambian al registrar la devolución',409);
 let locationId=null,shelf='',row='';
 if(location!==undefined){
  locationId=location.location_id===undefined||location.location_id===null||location.location_id===''?null:identifier(location.location_id);
  const template=locationId?(await c.query('select name from agency_inventory_storage_locations where id=$1 and organization_id=$2',[locationId,org])).rows[0]:null;
  if(locationId&&!template)fail('Lugar de guardado no encontrado',404);
  shelf=template?text(template.name,100):text(location.storage_shelf||'',100);
  row=text(location.storage_row||'',80);
 }
 let verified=0,moved=0;
 for(const item of rows){
  if(location!==undefined){
   const before=(await c.query('select storage_location_id,storage_shelf,storage_row from agency_inventory where id=$1 and organization_id=$2',[item.id,org])).rows[0];
   await c.query('update agency_inventory set storage_location_id=$1,storage_shelf=$2,storage_row=$3 where id=$4 and organization_id=$5',[locationId,shelf,row,item.id,org]);
   if(String(before.storage_location_id||'')!==String(locationId||'')||before.storage_shelf!==shelf||before.storage_row!==row){
    await traceInventory(c,org,[item.id],'location.changed',user.id,null,{from:before.storage_shelf||null,to:shelf||null});
    moved+=1;
   }
  }
  if(verify){await verifyItem(c,user,org,String(item.id),{result:'confirmed',differences:'',note:''});verified+=1;}
 }
 return {updated:rows.length,moved,verified};
}

async function verificationHistory(c,org,key){
 return (await c.query(`select v.*,coalesce(nullif(p.full_name,''),u.email) as verifier_name,p.photo_url as verifier_photo_url
  from agency_inventory_verifications v join users u on u.id=v.verified_by_user_id
  left join agency_user_profiles p on p.user_id=u.id and p.organization_id=v.organization_id
  where v.organization_id=$1 and v.inventory_id=$2 order by v.verified_at desc,v.id desc limit 30`,[org,key])).rows;
}
async function traceHistory(c,org,key){
 return (await c.query(`select t.*,i.inventory_code,coalesce(nullif(p.full_name,''),u.email) as actor_name,p.photo_url as actor_photo_url
  from agency_inventory_trace t join agency_inventory i on i.id=t.inventory_id and i.organization_id=t.organization_id
  left join users u on u.id=t.actor_user_id left join agency_user_profiles p on p.user_id=u.id and p.organization_id=t.organization_id
  where t.organization_id=$1 and t.inventory_id=$2 order by t.event_at desc,t.id desc limit 100`,[org,key])).rows;
}

export async function inventoryReservations({req,res,url,db,session,body,send}){
 const route=url.pathname.match(/^\/api\/agency\/(inventory|inventory-categories|inventory-locations|inventory-maintenance|inventory-reservations|inventory-context)(?:\/(\d+))?(?:\/(checkout|return|check-out|check-in|cancel|restore|verify|batch))?$/);
 if(!route)return false;
 let c,transaction=false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  const [,kind,rawKey,action]=route,key=rawKey?identifier(rawKey):null,write=req.method!=='GET';
  if(!['GET','POST','PATCH','DELETE'].includes(req.method))fail('Método no permitido',405);
  const capability=write?(kind==='inventory-reservations'?'inventory.book':'inventory.manage'):'inventory.view';
  if(!roleCan(user,capability))fail('Tu rol no permite esta operación',403);
  c=await db.connect();await c.query('begin isolation level read committed');transaction=true;
  const org=await authorize(c,user,capability,write);
  if(write)await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket?.remoteAddress||'']);
  let result,status=200;
  if(kind==='inventory-context'&&req.method==='GET'&&!key&&!action){
   result={user_id:String(user.id),role:user.role,time_zone:'America/Asuncion',can_manage:roleCan(user,'inventory.manage'),can_reserve:roleCan(user,'inventory.book'),
    // Viewer retains catalogue/calendar access, without gaining the member picker.
    members:roleCan(user,'inventory.book')?(await c.query(`select m.user_id::text as id,coalesce(nullif(p.full_name,''),u.email) as name from organization_members m join users u on u.id=m.user_id left join agency_user_profiles p on p.user_id=m.user_id and p.organization_id=m.organization_id where m.organization_id=$1 and m.active and m.removed_at is null order by name`,[org])).rows:[],
    projects:roleCan(user,'inventory.book')?(await c.query(`select p.id::text as id,p.name from agency_projects p join agency_clients a on a.id=p.client_id and a.organization_id=p.organization_id where p.organization_id=$1 and p.status='active' and a.active and ${visibleRecord('p','projects')} and ${visibleRecord('a','clients')} order by p.name`,[org])).rows:[]};
  }else if(kind==='inventory-categories'&&!action){
   if(req.method==='GET'&&!key)result={categories:(await c.query('select * from agency_inventory_categories where organization_id=$1 order by active desc,name',[org])).rows};
   else if(req.method==='POST'&&!key||req.method==='PATCH'&&key){
    const b=await body(req),old=key?(await c.query('select * from agency_inventory_categories where id=$1 and organization_id=$2',[key,org])).rows[0]:{};
    if(!old)fail('Categoría no encontrada',404);const name=text(b.name??old.name,80);if(name.length<2)fail('El nombre debe tener entre 2 y 80 caracteres.');
    const active=b.active??old.active??true;if(typeof active!=='boolean')fail('Estado de categoría inválido');
    let icon=old.icon??null;
    if(b.icon!==undefined){
     if(b.icon===null)icon=null;
     else if(typeof b.icon==='string'&&categoryIcons.includes(b.icon))icon=b.icon;
     else fail('Ícono de categoría no reconocido');
    }
    const row=key?(await c.query('update agency_inventory_categories set name=$1,active=$2,icon=$3 where id=$4 and organization_id=$5 returning *',[name,active,icon,key,org])).rows[0]:(await c.query('insert into agency_inventory_categories(organization_id,name,active,icon) values($1,$2,$3,$4) returning *',[org,name,active,icon])).rows[0];
    if(key)await c.query('update agency_inventory set category=$1 where category_id=$2 and organization_id=$3',[name,key,org]);
    result={category:row};status=key?200:201;
   }else fail('Método no permitido',405);
  }else if(kind==='inventory-locations'&&!action){
   if(req.method==='GET'&&!key)result={locations:await listStorageLocations(c,org)};
   else if(req.method==='POST'&&!key||req.method==='PATCH'&&key){
    const b=await body(req),old=key?(await c.query('select * from agency_inventory_storage_locations where id=$1 and organization_id=$2 for update',[key,org])).rows[0]:null;
    if(key&&!old)fail('Lugar de guardado no encontrado',404);
    const name=storageLocationName(b.name??old?.name);if(name.length<2)fail('El nombre del lugar debe tener entre 2 y 100 caracteres.');
    const active=b.active??old?.active??true;if(typeof active!=='boolean')fail('Estado de lugar inválido');
    const responsible=Object.hasOwn(b,'responsible_user_id')?optionalId(b.responsible_user_id):old?.responsible_user_id??null;
    if(responsible)await activeMembers(c,org,[responsible]);
    const row=old?(await c.query('update agency_inventory_storage_locations set name=$1,active=$2,responsible_user_id=$3,updated_at=now() where id=$4 and organization_id=$5 returning *',[name,active,responsible,key,org])).rows[0]:(await c.query('insert into agency_inventory_storage_locations(organization_id,name,active,responsible_user_id) values($1,$2,$3,$4) returning *',[org,name,active,responsible])).rows[0];
    result={location:row};status=old?200:201;
   }else if(req.method==='DELETE'&&key){
    const row=(await c.query('select id from agency_inventory_storage_locations where id=$1 and organization_id=$2 for update',[key,org])).rows[0];if(!row)fail('Lugar de guardado no encontrado',404);
    if((await c.query('select 1 from agency_inventory where organization_id=$1 and storage_location_id=$2 limit 1',[org,key])).rows.length)fail('El lugar está en uso por equipos. Archiválo en lugar de eliminarlo.',409);
    await c.query('delete from agency_inventory_storage_locations where id=$1 and organization_id=$2',[key,org]);result={ok:true};
   }else fail('Método no permitido',405);
  }else if(kind==='inventory-maintenance'&&!action){
   if(req.method==='GET'){
    const inventoryId=url.searchParams.get('inventory_id');
    result={maintenance:await maintenanceHistory(c,org,inventoryId?identifier(inventoryId):null)};
   }else if(req.method==='POST'&&!key||req.method==='PATCH'&&key){
    result={maintenance:await saveMaintenance(c,user,org,key,await body(req))};status=key?200:201;
   }else if(req.method==='DELETE'&&key){result=await voidMaintenance(c,user,org,key);}
   else fail('Método no permitido',405);
  }else if(kind==='inventory'){
   if(req.method==='GET'&&!action){const records=await catalog(c,org);if(key){const record=records.find(r=>String(r.id)===key);if(!record)fail('Equipo no encontrado',404);result={record,verifications:await verificationHistory(c,org,key),trace:await traceHistory(c,org,key),maintenance:await maintenanceHistory(c,org,key)};}else result={records};}
   else if(!action&&(req.method==='POST'&&!key||req.method==='PATCH'&&key)){result={record:await saveItem(c,user,org,key,await body(req))};status=key?200:201;}
   else if(key&&req.method==='POST'&&action==='verify'){result=await verifyItem(c,user,org,key,await body(req));}
   else if(!key&&req.method==='POST'&&action==='batch'){result=await batchItems(c,user,org,await body(req));}
   else if(key&&(req.method==='DELETE'&&!action||req.method==='POST'&&action==='restore')){
    const item=(await c.query('select id from agency_inventory where organization_id=$1 and id=$2 for update',[org,key])).rows[0];if(!item)fail('Equipo no encontrado',404);
    if(action==='restore')await c.query("delete from agency_archived_records where organization_id=$1 and kind='inventory' and record_id=$2",[org,key]);
    else{
     if((await c.query("select 1 from agency_inventory_reservation_items where organization_id=$1 and inventory_id=$2 and status in ('reserved','checked_out') limit 1",[org,key])).rows.length)fail('El equipo tiene una reserva abierta. Cancelala o registrá su devolución primero.',409);
     await c.query("insert into agency_archived_records(organization_id,kind,record_id,removed_by) values($1,'inventory',$2,$3) on conflict do nothing",[org,key,user.id]);
    }result={ok:true};
   }else fail('Método no permitido',405);
  }else if(kind==='inventory-reservations'){
   if(req.method==='GET'&&!action){
    const from=inventoryTimestamp(url.searchParams.get('from')||new Date(Date.now()-31*86400000).toISOString());
    const to=inventoryTimestamp(url.searchParams.get('to')||new Date(Date.now()+62*86400000).toISOString());
    if(to<=from||new Date(to)-new Date(from)>366*86400000)fail('Elegí un intervalo de hasta 366 días');
    const records=await listReservations(c,org,from,to,key);if(key&&!records.length)fail('Reserva no encontrada',404);result=key?{reservation:records[0]}:{reservations:records};
   }else if(!action&&(req.method==='POST'&&!key||req.method==='PATCH'&&key)){result={reservation:await saveReservation(c,user,org,await body(req),key)};status=key?200:201;}
   else if(req.method==='POST'&&key&&['checkout','return','check-out','check-in','cancel'].includes(action))result=await transition(c,user,org,key,action==='check-out'?'checkout':action==='check-in'?'return':action,await body(req));
   else fail('Método no permitido',405);
  }else fail('Método no permitido',405);
  await attributeActors(c,org,[
   {rows:result.reservations||result.reservation,userId:'created_by_user_id'},
   {rows:result.reservations||result.reservation,userId:'checked_out_by_user_id',prefix:'checkout_actor'},
   {rows:result.reservations||result.reservation,userId:'returned_by_user_id',prefix:'return_actor'},
  ]);
  await c.query('commit');transaction=false;send(res,status,result);
 }catch(error){
  if(transaction)await c.query('rollback');
  const conflict=['23P01','23505','40001','40P01'].includes(error.code);
  send(res,conflict?409:error.status||500,{error:conflict?'Los datos entran en conflicto con otro registro o reserva. Recargá y revisá la selección.':error.status?error.message:'No se pudo completar la operación de inventario'});
 }finally{c?.release();}
 return true;
}
