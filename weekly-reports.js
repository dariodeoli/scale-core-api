import {fail,date,text} from './suite-validation.js';
import {attributeActors} from './actor-identity.js';

export const categories=['videos','re_edits','designed_photos','productions'];
export const stages=['completed','in_progress','planned'];
export function reportWeek(value){
 const week=date(value);
 if(!week||new Date(week+'T12:00:00Z').getUTCDay()!==1)fail('Elegí el lunes de la semana');
 return week;
}
function object(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('Campos del reporte inválidos');
 return value;
}
function quantity(value,max,integer=true){
 if(value===null||value===undefined)return null;
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>max||(integer?!Number.isInteger(value):Math.abs(value*100-Math.round(value*100))>1e-8))fail('Cantidad inválida');
 return value;
}
export function declaration(raw){
 const b=object(raw,['metrics','notes','version']);
 if(!Number.isSafeInteger(b.version)||b.version<0||b.version>=2147483647)fail('Versión inválida');
 const m=object(b.metrics,[...categories,'raw_clips','production_days','declared_hours']);
 const metrics={};
 for(const category of categories){
  const counts=object(m[category]||{},stages);
  metrics[category]=Object.fromEntries(stages.map(stage=>[stage,quantity(counts[stage],100000)]));
 }
 metrics.raw_clips=quantity(m.raw_clips,1000000);
 metrics.production_days=quantity(m.production_days,7);
 metrics.declared_hours=quantity(m.declared_hours,168,false);
 return {metrics,notes:text(b.notes??'',3000),version:b.version};
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

export async function weeklyReports({req,res,url,db,session,body,send}){
 if(url.pathname!=='/api/agency/weekly-reports')return false;
 let c,tx=false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  if(!['GET','PUT'].includes(req.method))fail('Método no permitido',405);
  const week=reportWeek(url.searchParams.get('week'));
  const scope=url.searchParams.get('scope')||'own';
  if(!['own','team'].includes(scope)||[...url.searchParams.keys()].some(k=>!['week','scope'].includes(k)))fail('Consulta inválida');
  c=await db.connect();
  if(req.method==='PUT'){await c.query('begin');tx=true;}
  const member=(await c.query('select m.role from organization_members m join organizations o on o.id=m.organization_id where m.organization_id=$1 and m.user_id=$2 and m.active and m.removed_at is null and o.active'+(tx?' for share of m,o':''),[user.organization_id,user.id])).rows[0];
  if(!member)fail('Sin acceso a esta empresa',403);
  if(scope==='team'&&(member.role!=='owner'||user.role!=='owner'))fail('Solo el dueño puede ver los reportes del equipo',403);
  let result;
  if(req.method==='PUT'){
   if(scope!=='own'||member.role==='viewer'||user.role==='viewer')fail('Solo podés declarar tu propio trabajo con permiso de edición',403);
   const b=declaration(await body(req));
   const args=[user.organization_id,user.id,week,JSON.stringify(b.metrics),b.notes];
   const sql=b.version===0
    ? 'insert into agency_weekly_reports(organization_id,user_id,week_start,metrics,notes) values($1,$2,$3,$4,$5) on conflict do nothing returning *,week_start::text as week'
    : 'update agency_weekly_reports set metrics=$4,notes=$5,version=version+1,updated_at=now() where organization_id=$1 and user_id=$2 and week_start=$3 and version=$6 returning *,week_start::text as week';
   if(b.version!==0)args.push(b.version);
   const record=(await c.query(sql,args)).rows[0];
   if(!record)fail('El reporte cambió. Volvé a cargarlo antes de guardar.',409);
   result={records:[record]};
  }else{
   result={records:(await c.query('select r.*,r.week_start::text as week from agency_weekly_reports r where r.organization_id=$1 and r.week_start=$2 and ($3::bigint is null or r.user_id=$3) order by r.user_id',[user.organization_id,week,scope==='team'?null:user.id])).rows};
  }
  await attributeActors(c,user.organization_id,[{rows:result.records,userId:'user_id'}]);
  const automatic=await automaticCounts(c,user.organization_id,week,scope==='team'?null:user.id);
  await attributeActors(c,user.organization_id,[{rows:automatic,userId:'user_id'}]);
  if(tx){await c.query('commit');tx=false;}
  send(res,200,{...result,week,scope,source:'declared',automatic,canViewTeam:member.role==='owner'&&user.role==='owner',canEdit:member.role!=='viewer'&&user.role!=='viewer'&&scope==='own'});
 }catch(error){if(tx)await c.query('rollback');send(res,error.status||500,{error:error.status?error.message:'No se pudo cargar o guardar el reporte semanal'});}
 finally{c?.release();}
 return true;
}
