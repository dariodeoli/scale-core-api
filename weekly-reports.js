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
  if(tx){await c.query('commit');tx=false;}
  send(res,200,{...result,week,scope,source:'declared',canViewTeam:member.role==='owner'&&user.role==='owner',canEdit:member.role!=='viewer'&&user.role!=='viewer'&&scope==='own'});
 }catch(error){if(tx)await c.query('rollback');send(res,error.status||500,{error:error.status?error.message:'No se pudo cargar o guardar el reporte semanal'});}
 finally{c?.release();}
 return true;
}
