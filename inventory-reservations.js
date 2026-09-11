import {fail,text,amount,date,option} from './suite-validation.js';
import {visibleRecord} from './record-lifecycle.js';
import {currencies} from './currencies.js';
import {companyCurrency} from './forecast.js';

const managers=['owner','admin','management'];
const bookers=[...managers,'production'];
const readers=[...bookers,'finance','editor','viewer'];
const identifier=value=>{
 if(!['string','number'].includes(typeof value)||!/^\d{1,19}$/.test(String(value))||typeof value==='number'&&!Number.isSafeInteger(value))fail('Identificador inválido');
 const n=BigInt(value);if(n<=0n||n>=9223372036854775807n)fail('Identificador inválido');return String(n);
};
const optionalId=value=>value===null||value===undefined||value===''?null:identifier(value);
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

async function authorize(c,user,allowed,write){
 if(!allowed.includes(user.role))fail('Tu rol no permite esta operación',403);
 const org=identifier(user.organization_id);
 // All inventory mutations take this first, then membership/items in fixed order.
 // READ COMMITTED + a separate overlap query sees the previous committed writer.
 const company=(await c.query(`select id from organizations where id=$1 and active ${write?'for update':'for share'}`,[org])).rows[0];
 if(!company)fail('Sin acceso a esta empresa',403);
 const membership=(await c.query('select role from organization_members where organization_id=$1 and user_id=$2 and active and removed_at is null for share',[org,identifier(user.id)])).rows[0];
 // Check both session role (including demo preview) and current membership.
 if(!membership||!allowed.includes(membership.role))fail('Sin acceso activo para esta operación',403);
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
async function reservation(c,org,key){
 const row=(await c.query('select * from agency_inventory_reservations where id=$1 and organization_id=$2 for update',[key,org])).rows[0];
 if(!row)fail('Reserva no encontrada',404);return row;
}
function ownReservation(user,row){if(!managers.includes(user.role)&&String(row.created_by_user_id)!==String(user.id))fail('Solo podés gestionar tus propias reservas',403);}

async function catalog(c,org){
 return (await c.query(`select i.*,cat.name as category_name,cat.active as category_active,
  live.id as active_reservation_id,live.title as production_name,p.name as project_name,
  live.custodian_user_id as current_custodian_user_id,coalesce(nullif(up.full_name,''),u.email) as current_custodian_name,
  live.return_user_id,coalesce(nullif(rp.full_name,''),ru.email) as return_user_name,live.ends_at as expected_return_at,
  case when live.id is not null then 'checked_out' when i.status='in_use' then 'legacy_in_use' else 'storage' end as location_type
  from agency_inventory i left join agency_inventory_categories cat on cat.id=i.category_id and cat.organization_id=i.organization_id
  left join agency_inventory_reservation_items ri on ri.inventory_id=i.id and ri.organization_id=i.organization_id and ri.status='checked_out'
  left join agency_inventory_reservations live on live.id=ri.reservation_id and live.organization_id=i.organization_id
  left join agency_projects p on p.id=live.project_id and p.organization_id=i.organization_id
  left join users u on u.id=coalesce(live.custodian_user_id,i.custodian_user_id)
  left join agency_user_profiles up on up.user_id=u.id and up.organization_id=i.organization_id
  left join users ru on ru.id=live.return_user_id
  left join agency_user_profiles rp on rp.user_id=ru.id and rp.organization_id=i.organization_id
  where i.organization_id=$1 and ${visibleRecord('i','inventory')} order by i.name,i.id`,[org])).rows;
}
async function listReservations(c,org,from,to,key=null){
 return (await c.query(`select r.*,p.name as project_name,
  coalesce(nullif(rp.full_name,''),ru.email) as return_user_name,
  coalesce(nullif(cp.full_name,''),cu.email) as custodian_name,
  coalesce((select jsonb_agg(jsonb_build_object('id',i.id::text,'name',i.name,'storage_shelf',i.storage_shelf,'storage_row',i.storage_row) order by i.name)
   from agency_inventory_reservation_items ri join agency_inventory i on i.id=ri.inventory_id and i.organization_id=ri.organization_id where ri.reservation_id=r.id and ri.organization_id=r.organization_id),'[]') as items,
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
 return (await listReservations(c,org,start,end,saved.id))[0];
}
async function transition(c,user,org,key,action,payload){
 const row=await reservation(c,org,key);
 const assignedReturn=action==='return'&&bookers.includes(user.role)&&[row.return_user_id,row.custodian_user_id].some(id=>String(id)===String(user.id));
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
  await c.query("update agency_inventory_reservations set status='checked_out',custodian_user_id=$1,checked_out_at=now(),checked_out_by_user_id=$2,version=version+1,updated_at=now() where id=$3 and organization_id=$4",[custodian,user.id,key,org]);
  await c.query("update agency_inventory set status='in_use',custodian_user_id=$1 where organization_id=$2 and id=any($3::bigint[])",[custodian,org,ids]);
 }else if(action==='return'){
  if(row.status!=='checked_out')fail('Primero registrá el retiro',409);
  const ids=(await c.query('select inventory_id::text as id from agency_inventory_reservation_items where reservation_id=$1 and organization_id=$2',[key,org])).rows.map(r=>r.id);
  const locations=payload.locations;
  if(!Array.isArray(locations)||locations.length!==ids.length)fail('Indicá dónde queda cada equipo devuelto');
  const seen=new Set();
  for(const location of locations){
   if(!location||typeof location!=='object'||Array.isArray(location))fail('Indicá una ubicación válida para cada equipo');
   const id=identifier(location.inventory_id);if(!ids.includes(id)||seen.has(id))fail('La devolución debe incluir cada equipo una sola vez');seen.add(id);
   if(!text(location.storage_shelf,100))fail('Indicá el estante o lugar de guardado de cada equipo');
   text(location.storage_row||'',80);option(location.status||'available',['available','maintenance']);
  }
  // Returns remain possible when a project ended or an assignee was suspended.
  await c.query("update agency_inventory_reservations set status='returned',returned_at=now(),returned_by_user_id=$1,version=version+1,updated_at=now() where id=$2 and organization_id=$3",[user.id,key,org]);
  for(const location of locations)await c.query('update agency_inventory set status=$1,custodian_user_id=null,storage_shelf=$2,storage_row=$3 where id=$4 and organization_id=$5',[location.status||'available',text(location.storage_shelf,100),text(location.storage_row||'',80),location.inventory_id,org]);
 }else{
  if(row.status!=='reserved')fail('Una reserva retirada se cierra registrando la devolución',409);
  await c.query("update agency_inventory_reservations set status='cancelled',cancelled_at=now(),version=version+1,updated_at=now() where id=$1 and organization_id=$2",[key,org]);
 }
 return {reservation:(await listReservations(c,org,null,null,key))[0]};
}

async function saveItem(c,org,key,payload){
 const old=key?(await equipment(c,org,[key]))[0]:{};
 const merged={...old,...payload},name=text(merged.name,160);if(name.length<2)fail('Ingresá el nombre del equipo');
 let category;
 if(Object.hasOwn(payload,'category_id')||!Object.hasOwn(payload,'category')&&old.category_id){
  category=(await c.query('select * from agency_inventory_categories where id=$1 and organization_id=$2',[identifier(merged.category_id),org])).rows[0];
 }else{
  const categoryName=text(merged.category||'Otro',80);
  if(!categoryName)fail('Ingresá el nombre de la categoría');
  category=(await c.query('select * from agency_inventory_categories where organization_id=$1 and lower(trim(name))=lower($2)',[org,categoryName])).rows[0];
  if(!category)category=(await c.query('insert into agency_inventory_categories(organization_id,name) values($1,$2) returning *',[org,categoryName])).rows[0];
 }
 if(!category||!category.active&&String(category.id)!==String(old.category_id))fail('Elegí una categoría activa de esta empresa');
 const status=option(merged.status||'available',['available','in_use','maintenance','retired']);
 if(status==='in_use'&&old.status!=='in_use')fail('Usá Registrar retiro para indicar quién lleva el equipo');
 const custodian=optionalId(merged.custodian_user_id);if(custodian)await activeMembers(c,org,[custodian]);
 const shelf=text(merged.storage_shelf||'',100),storageRow=text(merged.storage_row||'',80);
 if(key){
  const open=(await c.query("select status from agency_inventory_reservation_items where inventory_id=$1 and organization_id=$2 and status in ('reserved','checked_out')",[key,org])).rows;
  if(open.length&&status!==old.status)fail('Cerrá o cancelá las reservas antes de cambiar el estado del equipo',409);
  if(open.some(r=>r.status==='checked_out')&&(custodian!==optionalId(old.custodian_user_id)||shelf!==old.storage_shelf||storageRow!==old.storage_row))fail('La ubicación y el custodio se cambian al registrar la devolución',409);
 }
 const values=[name,category.name,text(merged.serial_number||'',120),custodian,amount(merged.value??0),option(merged.currency===undefined?await companyCurrency(c,org):merged.currency,currencies),status,date(merged.acquired_on),text(merged.notes||''),category.id,shelf,storageRow,org];
 const result=key?await c.query('update agency_inventory set name=$1,category=$2,serial_number=$3,custodian_user_id=$4,value=$5,currency=$6,status=$7,acquired_on=$8,notes=$9,category_id=$10,storage_shelf=$11,storage_row=$12 where organization_id=$13 and id=$14 returning *',[...values,key]):await c.query('insert into agency_inventory(name,category,serial_number,custodian_user_id,value,currency,status,acquired_on,notes,category_id,storage_shelf,storage_row,organization_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *',values);
 return result.rows[0];
}

export async function inventoryReservations({req,res,url,db,session,body,send}){
 const route=url.pathname.match(/^\/api\/agency\/(inventory|inventory-categories|inventory-reservations|inventory-context)(?:\/(\d+))?(?:\/(checkout|return|cancel|restore))?$/);
 if(!route)return false;
 let c,transaction=false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  const [,kind,rawKey,action]=route,key=rawKey?identifier(rawKey):null,write=req.method!=='GET';
  if(!['GET','POST','PATCH','DELETE'].includes(req.method))fail('Método no permitido',405);
  const allowed=write?(kind==='inventory-reservations'?bookers:managers):readers;
  if(!allowed.includes(user.role))fail('Tu rol no permite esta operación',403);
  c=await db.connect();await c.query('begin isolation level read committed');transaction=true;
  const org=await authorize(c,user,allowed,write);
  if(write)await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket?.remoteAddress||'']);
  let result,status=200;
  if(kind==='inventory-context'&&req.method==='GET'&&!key&&!action){
   result={user_id:String(user.id),role:user.role,time_zone:'America/Asuncion',can_manage:managers.includes(user.role),can_reserve:bookers.includes(user.role),
    // Viewer retains catalogue/calendar access, without gaining the member picker.
    members:bookers.includes(user.role)?(await c.query(`select m.user_id::text as id,coalesce(nullif(p.full_name,''),u.email) as name from organization_members m join users u on u.id=m.user_id left join agency_user_profiles p on p.user_id=m.user_id and p.organization_id=m.organization_id where m.organization_id=$1 and m.active and m.removed_at is null order by name`,[org])).rows:[],
    projects:bookers.includes(user.role)?(await c.query(`select p.id::text as id,p.name from agency_projects p join agency_clients a on a.id=p.client_id and a.organization_id=p.organization_id where p.organization_id=$1 and p.status='active' and a.active and ${visibleRecord('p','projects')} and ${visibleRecord('a','clients')} order by p.name`,[org])).rows:[]};
  }else if(kind==='inventory-categories'&&!action){
   if(req.method==='GET'&&!key)result={categories:(await c.query('select * from agency_inventory_categories where organization_id=$1 order by active desc,name',[org])).rows};
   else if(req.method==='POST'&&!key||req.method==='PATCH'&&key){
    const b=await body(req),old=key?(await c.query('select * from agency_inventory_categories where id=$1 and organization_id=$2',[key,org])).rows[0]:{};
    if(!old)fail('Categoría no encontrada',404);const name=text(b.name??old.name,80);if(!name)fail('Ingresá el nombre de la categoría');
    const active=b.active??old.active??true;if(typeof active!=='boolean')fail('Estado de categoría inválido');
    const row=key?(await c.query('update agency_inventory_categories set name=$1,active=$2 where id=$3 and organization_id=$4 returning *',[name,active,key,org])).rows[0]:(await c.query('insert into agency_inventory_categories(organization_id,name,active) values($1,$2,$3) returning *',[org,name,active])).rows[0];
    if(key)await c.query('update agency_inventory set category=$1 where category_id=$2 and organization_id=$3',[name,key,org]);
    result={category:row};status=key?200:201;
   }else fail('Método no permitido',405);
  }else if(kind==='inventory'){
   if(req.method==='GET'&&!action){const records=await catalog(c,org);if(key){const record=records.find(r=>String(r.id)===key);if(!record)fail('Equipo no encontrado',404);result={record};}else result={records};}
   else if(!action&&(req.method==='POST'&&!key||req.method==='PATCH'&&key)){result={record:await saveItem(c,org,key,await body(req))};status=key?200:201;}
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
   else if(req.method==='POST'&&key&&['checkout','return','cancel'].includes(action))result=await transition(c,user,org,key,action,await body(req));
   else fail('Método no permitido',405);
  }else fail('Método no permitido',405);
  await c.query('commit');transaction=false;send(res,status,result);
 }catch(error){
  if(transaction)await c.query('rollback');
  const conflict=['23P01','23505','40001','40P01'].includes(error.code);
  send(res,conflict?409:error.status||500,{error:conflict?'Los datos entran en conflicto con otro registro o reserva. Recargá y revisá la selección.':error.status?error.message:'No se pudo completar la operación de inventario'});
 }finally{c?.release();}
 return true;
}
