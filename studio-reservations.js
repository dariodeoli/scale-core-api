import {attributeActors} from './actor-identity.js';
import {roleCan} from './permissions.js';
import {fail,text} from './suite-validation.js';
import {visibleRecord} from './record-lifecycle.js';




const productionTypes=['video','podcast','ads','fotografia','streaming','otro'];

const identifier=value=>{
 if(!['string','number'].includes(typeof value)||!/^\d{1,19}$/.test(String(value))||typeof value==='number'&&!Number.isSafeInteger(value))fail('Identificador inválido');
 const number=BigInt(value);if(number<=0n||number>=9223372036854775807n)fail('Identificador inválido');return String(number);
};
const optionalId=value=>value===null||value===undefined||value===''?null:identifier(value);
function identifiers(values,label,max=30){
 if(!Array.isArray(values)||!values.length||values.length>max)fail(`Elegí entre 1 y ${max} ${label}`);
 const ids=values.map(identifier);if(new Set(ids).size!==ids.length)fail(`No repitas ${label}`);return ids.sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
}
export function studioTimestamp(value){
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/.test(value))fail('Ingresá fecha y hora con zona horaria');
 const parsed=new Date(value);if(!Number.isFinite(parsed.getTime()))fail('Fecha u hora inválida');
 const day=value.slice(0,10),check=new Date(`${day}T00:00:00Z`);if(check.toISOString().slice(0,10)!==day)fail('Fecha inválida');
 return parsed.toISOString();
}
const version=(value,current)=>{if(!Number.isInteger(value)||value!==current)fail('La reserva cambió. Recargá antes de guardar.',409);};

async function authorize(connection,user,allowed,write){
 if(!roleCan(user,allowed))fail('Tu rol no permite esta operación',403);
 const organization=identifier(user.organization_id);
 const company=(await connection.query(`select id from organizations where id=$1 and active ${write?'for update':'for share'}`,[organization])).rows[0];
 if(!company)fail('Sin acceso a esta empresa',403);
 const membership=(await connection.query('select role from organization_members where organization_id=$1 and user_id=$2 and active and removed_at is null for share',[organization,identifier(user.id)])).rows[0];
 if(!membership||!roleCan({role:membership.role,capabilities:user.capabilities},allowed))fail('Sin acceso activo para esta operación',403);
 return organization;
}
async function activeMembers(connection,organization,ids){
 const members=(await connection.query('select user_id::text as id from organization_members where organization_id=$1 and user_id=any($2::bigint[]) and active and removed_at is null order by user_id for share',[organization,ids])).rows;
 if(members.length!==ids.length)fail('Los responsables deben tener acceso activo a esta empresa');
}
async function activeProject(connection,organization,id){
 if(!id)return null;
 const project=(await connection.query(`select p.id from agency_projects p join agency_clients c on c.id=p.client_id and c.organization_id=p.organization_id
  where p.id=$1 and p.organization_id=$2 and p.status='active' and c.active and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')} for share of p,c`,[id,organization])).rows[0];
 if(!project)fail('Elegí un proyecto activo de esta empresa');return project;
}
async function studioSpace(connection,organization,id,lock='for share'){
 const space=(await connection.query(`select * from agency_studio_spaces where id=$1 and organization_id=$2 ${lock}`,[id,organization])).rows[0];
 if(!space)fail('Espacio de estudio no encontrado',404);return space;
}
async function studioReservation(connection,organization,id){
 const reservation=(await connection.query('select * from agency_studio_reservations where id=$1 and organization_id=$2 for update',[id,organization])).rows[0];
 if(!reservation)fail('Reserva de estudio no encontrada',404);return reservation;
}
function ownReservation(user,reservation){if(!roleCan(user,'studio.manage')&&String(reservation.created_by_user_id)!==String(user.id))fail('Solo podés gestionar tus propias reservas',403);}

async function context(connection,organization,user){
 // Decisión de producto (issue #18): reservar el estudio se gobierna con studio.manage.
 const canReserve=roleCan(user,'studio.manage');
 return {user_id:String(user.id),role:user.role,time_zone:'America/Asuncion',can_manage:roleCan(user,'studio.manage'),can_reserve:canReserve,
  members:canReserve?(await connection.query(`select m.user_id::text as id,coalesce(nullif(p.full_name,''),u.email) as name,p.photo_url
   from organization_members m join users u on u.id=m.user_id left join agency_user_profiles p on p.user_id=m.user_id and p.organization_id=m.organization_id
   where m.organization_id=$1 and m.active and m.removed_at is null order by name`,[organization])).rows:[],
  projects:canReserve?(await connection.query(`select p.id::text as id,p.name,coalesce(c.name,'') as client_name from agency_projects p join agency_clients c on c.id=p.client_id and c.organization_id=p.organization_id
   where p.organization_id=$1 and p.status='active' and c.active and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')} order by c.name,p.name`,[organization])).rows:[]};
}
async function listSpaces(connection,organization){return (await connection.query('select * from agency_studio_spaces where organization_id=$1 order by active desc,name,id',[organization])).rows;}
async function listReservations(connection,organization,from,to,id=null){
 return (await connection.query(`select r.*,s.name as space_name,s.scenario as space_scenario,p.name as project_name,
  coalesce((select jsonb_agg(jsonb_build_object('id',m.user_id::text,'name',coalesce(nullif(up.full_name,''),u.email),'photo_url',up.photo_url) order by m.user_id)
   from agency_studio_reservation_members m join users u on u.id=m.user_id left join agency_user_profiles up on up.user_id=m.user_id and up.organization_id=m.organization_id
   where m.reservation_id=r.id and m.organization_id=r.organization_id),'[]') as responsible_members
  from agency_studio_reservations r join agency_studio_spaces s on s.id=r.space_id and s.organization_id=r.organization_id
  left join agency_projects p on p.id=r.project_id and p.organization_id=r.organization_id
  where r.organization_id=$1 and ($4::bigint is null or r.id=$4)
   and ($4::bigint is not null or (r.starts_at<$3::timestamptz and r.ends_at>$2::timestamptz))
  order by r.starts_at,r.id`,[organization,from,to,id])).rows;
}
async function saveSpace(connection,user,organization,id,payload){
 const old=id?await studioSpace(connection,organization,id,'for update'):{};
 const merged={...old,...payload},name=text(merged.name,120);if(name.length<2)fail('Ingresá un nombre para el espacio');
 const scenario=text(merged.scenario||'',120),notes=text(merged.notes||'',2000),active=merged.active??true;
 if(typeof active!=='boolean')fail('Estado del espacio inválido');
 if(id)return (await connection.query('update agency_studio_spaces set name=$1,scenario=$2,notes=$3,active=$4,updated_at=now() where id=$5 and organization_id=$6 returning *',[name,scenario,notes,active,id,organization])).rows[0];
 return (await connection.query('insert into agency_studio_spaces(organization_id,name,scenario,notes,active,created_by_user_id) values($1,$2,$3,$4,$5,$6) returning *',[organization,name,scenario,notes,active,user.id])).rows[0];
}
async function saveReservation(connection,user,organization,payload,id){
 const old=id?await studioReservation(connection,organization,id):null;
 if(old){ownReservation(user,old);if(old.status!=='reserved')fail('Solo se pueden editar reservas activas',409);version(payload.expected_version,old.version);}
 const spaceId=identifier(payload.space_id),projectId=optionalId(payload.project_id),members=identifiers(payload.responsible_user_ids,'responsables'),title=text(payload.title,160);
 if(title.length<2)fail('Nombrá la producción o reserva');
 if(user.role==='production'&&!members.includes(String(user.id)))fail('Incluite entre los responsables de tu reserva');
 if(!productionTypes.includes(payload.production_type))fail('Elegí un tipo de producción válido');
 const starts=studioTimestamp(payload.starts_at),ends=studioTimestamp(payload.ends_at);
 if(ends<=starts||new Date(ends)-new Date(starts)>366*86400000)fail('El fin debe ser posterior al inicio, dentro de 366 días');
 const space=await studioSpace(connection,organization,spaceId,'for update');if(!space.active&&String(space.id)!==String(old?.space_id))fail('Elegí un espacio activo');
 await activeProject(connection,organization,projectId);await activeMembers(connection,organization,members);
 const conflict=(await connection.query(`select 1 from agency_studio_reservations where organization_id=$1 and space_id=$2 and id<>coalesce($5::bigint,0)
  and status='reserved' and starts_at<$4::timestamptz and ends_at>$3::timestamptz limit 1`,[organization,spaceId,starts,ends,id])).rows.length;
 if(conflict)fail('Ese espacio ya está reservado en ese horario. Elegí otro horario o escenario.',409);
 let saved;
 if(old){
  await connection.query('delete from agency_studio_reservation_members where reservation_id=$1 and organization_id=$2',[id,organization]);
  saved=(await connection.query('update agency_studio_reservations set space_id=$1,project_id=$2,title=$3,production_type=$4,starts_at=$5,ends_at=$6,notes=$7,version=version+1,updated_at=now() where id=$8 and organization_id=$9 returning *',[spaceId,projectId,title,payload.production_type,starts,ends,text(payload.notes||'',2000),id,organization])).rows[0];
 }else saved=(await connection.query('insert into agency_studio_reservations(organization_id,space_id,project_id,title,production_type,starts_at,ends_at,notes,created_by_user_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[organization,spaceId,projectId,title,payload.production_type,starts,ends,text(payload.notes||'',2000),user.id])).rows[0];
 for(const member of members)await connection.query('insert into agency_studio_reservation_members(organization_id,reservation_id,user_id) values($1,$2,$3)',[organization,saved.id,member]);
 return (await listReservations(connection,organization,starts,ends,saved.id))[0];
}

export async function studioReservations({req,res,url,db,session,body,send}){
 const route=url.pathname.match(/^\/api\/agency\/(studio-spaces|studio-reservations|studio-context)(?:\/(\d+))?(?:\/(cancel))?$/);
 if(!route)return false;
 let connection,transaction=false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  const [,kind,rawId,action]=route,id=rawId?identifier(rawId):null,write=req.method!=='GET';
  if(!['GET','POST','PATCH'].includes(req.method))fail('Método no permitido',405);
  const allowed=write?'studio.manage':'inventory.view';
  if(!roleCan(user,allowed))fail('Tu rol no permite esta operación',403);
  connection=await db.connect();await connection.query('begin isolation level read committed');transaction=true;
  const organization=await authorize(connection,user,allowed,write);
  if(write)await connection.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket?.remoteAddress||'']);
  let result,status=200;
  if(kind==='studio-context'&&req.method==='GET'&&!id&&!action)result=await context(connection,organization,user);
  else if(kind==='studio-spaces'&&!action){
   if(req.method==='GET'&&!id)result={spaces:await listSpaces(connection,organization)};
   else if((req.method==='POST'&&!id)||(req.method==='PATCH'&&id)){result={space:await saveSpace(connection,user,organization,id,await body(req))};status=id?200:201;}
   else fail('Método no permitido',405);
  }else if(kind==='studio-reservations'){
   if(req.method==='GET'&&!action){
    const from=studioTimestamp(url.searchParams.get('from')||new Date(Date.now()-31*86400000).toISOString()),to=studioTimestamp(url.searchParams.get('to')||new Date(Date.now()+62*86400000).toISOString());
    if(to<=from||new Date(to)-new Date(from)>366*86400000)fail('Elegí un intervalo de hasta 366 días');
    const reservations=await listReservations(connection,organization,from,to,id);if(id&&!reservations.length)fail('Reserva de estudio no encontrada',404);result=id?{reservation:reservations[0]}:{reservations};
   }else if(!action&&((req.method==='POST'&&!id)||(req.method==='PATCH'&&id))){result={reservation:await saveReservation(connection,user,organization,await body(req),id)};status=id?200:201;}
   else if(req.method==='POST'&&id&&action==='cancel'){
    const reservation=await studioReservation(connection,organization,id);ownReservation(user,reservation);
    if(reservation.status==='cancelled')result={reservation:(await listReservations(connection,organization,null,null,id))[0],alreadyRecorded:true};
    else {version((await body(req)).expected_version,reservation.version);await connection.query("update agency_studio_reservations set status='cancelled',cancelled_at=now(),cancelled_by_user_id=$1,version=version+1,updated_at=now() where id=$2 and organization_id=$3",[user.id,id,organization]);result={reservation:(await listReservations(connection,organization,null,null,id))[0]};}
   }else fail('Método no permitido',405);
  }else fail('Método no permitido',405);
  await attributeActors(connection,organization,[{rows:result.reservations||result.reservation,userId:'created_by_user_id'}]);
  await connection.query('commit');transaction=false;send(res,status,result);
 }catch(error){
  if(transaction)await connection.query('rollback');
  const conflict=['23P01','23505','40001','40P01'].includes(error.code);
  send(res,conflict?409:error.status||500,{error:conflict?'El espacio entra en conflicto con otra reserva. Recargá y elegí otro horario.':error.status?error.message:'No se pudo completar la reserva de estudio'});
 }finally{connection?.release();}
 return true;
}
