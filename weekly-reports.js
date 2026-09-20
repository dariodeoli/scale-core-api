import {fail,date} from './suite-validation.js';
import {attributeActors} from './actor-identity.js';

export function reportWeek(value){
 const week=date(value);
 if(!week||new Date(week+'T12:00:00Z').getUTCDay()!==1)fail('Elegí el lunes de la semana');
 return week;
}

const automaticTypes=['video','reedicion','foto','produccion','entregable','untyped'];
export async function automaticCounts(c,organizationId,week,userId=null){
 // Finished counts derive from the append-only audit: the first UPDATE per work
 // order whose after_state reaches approved|published, bucketed to the week of
 // that transition. Each order counts once per report, attributed to the
 // transition actor; non-numeric/system actors are ignored.
 const rows=(await c.query(`
  select t.actor as user_id, coalesce(t.work_type,'untyped') as work_type, count(*)::int as count
  from (
   select distinct on (a.organization_id, coalesce((a.after_state->>'id')::bigint,0))
    a.actor, a.after_state->>'work_type' as work_type, a.created_at
   from agency_operation_audit a
   where a.organization_id=$1 and a.table_name='agency_work_orders' and a.action='UPDATE'
    and a.after_state->>'status' in ('approved','published')
    and coalesce(a.before_state->>'status','') not in ('approved','published')
    and a.actor ~ '^[1-9][0-9]*$'
   order by a.organization_id, coalesce((a.after_state->>'id')::bigint,0), a.created_at
  ) t
  where (t.created_at at time zone 'America/Asuncion')::date between $2::date and ($2::date + interval '6 days')
   and ($3::bigint is null or t.actor::bigint=$3)
  group by t.actor, coalesce(t.work_type,'untyped')
 `,[organizationId,week,userId])).rows;
 // Orders worked: every audited operation on a work order (insert, update or
 // delete) during the week counts that order exactly once per actor, whether or
 // not the piece finished. Deletes attribute through before_state; system and
 // non-numeric actors stay out, matching the transition counts above.
  const orderRows=(await c.query(`
  select a.actor as user_id, count(distinct coalesce((a.after_state->>'id')::bigint,(a.before_state->>'id')::bigint))::int as orders
  from agency_operation_audit a
  where a.organization_id=$1 and a.table_name='agency_work_orders'
   and a.actor ~ '^[1-9][0-9]*$'
   and coalesce((a.after_state->>'id')::bigint,(a.before_state->>'id')::bigint) is not null
   and (a.created_at at time zone 'America/Asuncion')::date between $2::date and ($2::date + interval '6 days')
   and ($3::bigint is null or a.actor::bigint=$3)
  group by a.actor
 `,[organizationId,week,userId])).rows;
 // Project breakdown: finished pieces reuse the same first-transition rule as
 // the type counts, bucketed per project; orders worked mirror the orders query
 // above but grouped per project. Both derive the project link from the audit
 // row snapshots (project_id), joined to agency_projects only for the name.
 const projectRows=(await c.query(`
  select t.actor as user_id, coalesce((t.project_id)::bigint,0) as project_id, count(*)::int as count
  from (
   select distinct on (a.organization_id, coalesce((a.after_state->>'id')::bigint,0))
    a.actor, a.after_state->>'project_id' as project_id, a.created_at
   from agency_operation_audit a
   where a.organization_id=$1 and a.table_name='agency_work_orders' and a.action='UPDATE'
    and a.after_state->>'status' in ('approved','published')
    and coalesce(a.before_state->>'status','') not in ('approved','published')
    and a.actor ~ '^[1-9][0-9]*$'
   order by a.organization_id, coalesce((a.after_state->>'id')::bigint,0), a.created_at
  ) t
  where (t.created_at at time zone 'America/Asuncion')::date between $2::date and ($2::date + interval '6 days')
   and ($3::bigint is null or t.actor::bigint=$3)
  group by t.actor, t.project_id
 `,[organizationId,week,userId])).rows;
 const projectOrderRows=(await c.query(`
  select a.actor as user_id,
   coalesce((a.after_state->>'project_id')::bigint,(a.before_state->>'project_id')::bigint,0) as project_id,
   count(distinct coalesce((a.after_state->>'id')::bigint,(a.before_state->>'id')::bigint))::int as orders
  from agency_operation_audit a
  where a.organization_id=$1 and a.table_name='agency_work_orders'
   and a.actor ~ '^[1-9][0-9]*$'
   and coalesce((a.after_state->>'id')::bigint,(a.before_state->>'id')::bigint) is not null
   and (a.created_at at time zone 'America/Asuncion')::date between $2::date and ($2::date + interval '6 days')
   and ($3::bigint is null or a.actor::bigint=$3)
  group by a.actor, coalesce((a.after_state->>'project_id')::bigint,(a.before_state->>'project_id')::bigint,0)
 `,[organizationId,week,userId])).rows;
 const names=new Map((await c.query('select id, name from agency_projects where organization_id=$1',[organizationId])).rows.map(row=>[String(Number(row.id)),row.name]));
 const automatic=new Map();
 const entryFor=key=>automatic.get(key)||{user_id:key,counts:Object.fromEntries(automaticTypes.map(type=>[type,0])),orders:0,projects:[]};
 for(const row of rows){
  const key=String(row.user_id),entry=entryFor(key);
  entry.counts[row.work_type]=(entry.counts[row.work_type]||0)+row.count;
  automatic.set(key,entry);
 }
 for(const row of orderRows){
  const key=String(row.user_id),entry=entryFor(key);
  entry.orders=(entry.orders||0)+row.orders;
  automatic.set(key,entry);
 }
 const projectFor=(entry,id)=>{
  const project_id=Number(id);
  let project=entry.projects.find(item=>item.project_id===project_id);
  if(!project){project={project_id,project_name:names.get(String(project_id))??null,count:0,orders:0};entry.projects.push(project);}
  return project;
 };
 for(const row of projectRows){
  const key=String(row.user_id),entry=entryFor(key);
  projectFor(entry,row.project_id).count+=row.count;
  automatic.set(key,entry);
 }
 for(const row of projectOrderRows){
  const key=String(row.user_id),entry=entryFor(key);
  projectFor(entry,row.project_id).orders+=row.orders;
  automatic.set(key,entry);
 }
 for(const entry of automatic.values())entry.projects.sort((a,b)=>b.count-a.count||a.project_id-b.project_id);
 return [...automatic.values()];
}

// The declared weekly surface (PUT with metrics/notes, plus the records, canEdit
// and canViewTeam fields) was retired: the frontend page that consumed it was
// removed on 2026-09-14 and the audit-derived `automatic` section supersedes the
// manual declarations. `agency_weekly_reports` keeps its historical rows (no
// destructive migration); re-exposing a declaration UI needs its own issue.
export async function weeklyReports({req,res,url,db,session,send}){
 if(url.pathname!=='/api/agency/weekly-reports')return false;
 let c;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  if(req.method!=='GET')fail('Método no permitido',405);
  const week=reportWeek(url.searchParams.get('week'));
  const scope=url.searchParams.get('scope')||'own';
  if(!['own','team'].includes(scope)||[...url.searchParams.keys()].some(key=>!['week','scope'].includes(key)))fail('Consulta inválida');
  c=await db.connect();
  const member=(await c.query('select m.role from organization_members m join organizations o on o.id=m.organization_id where m.organization_id=$1 and m.user_id=$2 and m.active and m.removed_at is null and o.active',[user.organization_id,user.id])).rows[0];
  if(!member)fail('Sin acceso a esta empresa',403);
  if(scope==='team'&&(member.role!=='owner'||user.role!=='owner'))fail('Solo el dueño puede ver los reportes del equipo',403);
  const automatic=await automaticCounts(c,user.organization_id,week,scope==='team'?null:user.id);
  await attributeActors(c,user.organization_id,[{rows:automatic,userId:'user_id'}]);
  send(res,200,{week,scope,automatic});
 }catch(error){send(res,error.status||500,{error:error.status?error.message:'No se pudo cargar el reporte semanal'});}
 finally{c?.release();}
 return true;
}
