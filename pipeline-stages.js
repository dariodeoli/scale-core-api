import {fail,text,option} from './suite-validation.js';
import {roleCan} from './permissions.js';

// Defaults match the stages that shipped fixed in code before this table.
const stageDefaults = [
 ['lead','Lead',0,'open'],
 ['contacted','Contactado',1,'open'],
 ['proposal','Propuesta',2,'open'],
 ['negotiation','Negociación',3,'open'],
 ['won','Ganado',4,'won'],
 ['lost','Perdido',5,'lost'],
];
const stageFields = 'id::text as id,slug,label,position,active,kind';
const slugify = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);

// Idempotent: only fills a company without stages, so any creation path can
// call it. Existing companies were seeded by the migration.
export async function ensurePipelineStages(c,org){
 const count=(await c.query('select count(*)::int as count from agency_pipeline_stages where organization_id=$1',[org])).rows[0].count;
 if(!count)for(const [slug,label,position,kind] of stageDefaults)
  await c.query('insert into agency_pipeline_stages(organization_id,slug,label,position,kind) values($1,$2,$3,$4,$5) on conflict(organization_id,slug) do nothing',[org,slug,label,position,kind]);
 return (await c.query(`select ${stageFields} from agency_pipeline_stages where organization_id=$1 order by position,id`,[org])).rows;
}
export const defaultLeadStage = stages => (stages.find(stage=>stage.active&&stage.kind==='open')||stages.find(stage=>stage.active)||{}).slug||null;
export const wonLeadStage = stages => (stages.find(stage=>stage.active&&stage.kind==='won')||{}).slug||'won';

export async function pipelineStages({req,res,url,db,session,body,send}){
 const route=url.pathname.match(/^\/api\/agency\/pipeline-stages(?:\/(\d+))?$/);
 if(!route)return false;
 let c,transaction=false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  if(!roleCan(user,'commercial.manage'))fail('Tu rol no permite esta operación',403);
  if(!['GET','POST','PATCH','DELETE'].includes(req.method))fail('Método no permitido',405);
  const key=route[1]||null;
  c=await db.connect();await c.query('begin');transaction=true;
  const org=String(user.organization_id);
  if(req.method!=='GET')await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket?.remoteAddress||'']);
  let result,status=200;
  if(req.method==='GET'&&!key){
   result={stages:await ensurePipelineStages(c,org)};
  }else if(req.method==='POST'&&!key){
   await ensurePipelineStages(c,org);
   const b=await body(req),label=text(b.label??b.name,60);
   if(label.length<2)fail('Ingresá el nombre de la etapa');
   const kind=option(b.kind||'open',['open','won','lost']);
   let slug=b.slug===undefined?'':text(b.slug,40).toLowerCase();
   if(slug&&!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(slug))fail('Código de etapa inválido');
   if(!slug)slug=slugify(label);
   if(!slug)fail('Usá un nombre con letras o números');
   if((await c.query('select 1 from agency_pipeline_stages where organization_id=$1 and slug=$2',[org,slug])).rows.length)fail('Ya existe una etapa con ese nombre o código',409);
   let position=b.position===undefined?null:Number(b.position);
   if(position!==null&&(!Number.isInteger(position)||position<0||position>9999))fail('Orden de etapa inválido');
   if(position===null)position=(await c.query('select (coalesce(max(position),-1)+1)::int as next from agency_pipeline_stages where organization_id=$1',[org])).rows[0].next;
   const active=b.active===undefined?true:b.active;if(typeof active!=='boolean')fail('Estado de etapa inválido');
   result={stage:(await c.query('insert into agency_pipeline_stages(organization_id,slug,label,position,active,kind) values($1,$2,$3,$4,$5,$6) returning '+stageFields,[org,slug,label,position,active,kind])).rows[0]};status=201;
  }else if(req.method==='PATCH'&&key){
   const old=(await c.query('select * from agency_pipeline_stages where id=$1 and organization_id=$2 for update',[key,org])).rows[0];
   if(!old)fail('Etapa no encontrada',404);
   const b=await body(req);
   if(Object.hasOwn(b,'slug')&&text(b.slug,40).toLowerCase()!==old.slug)fail('El código de la etapa es estable y no se puede cambiar',409);
   const label=b.label===undefined?old.label:text(b.label,60);if(label.length<2)fail('Ingresá el nombre de la etapa');
   let position=old.position;
   if(b.position!==undefined){position=Number(b.position);if(!Number.isInteger(position)||position<0||position>9999)fail('Orden de etapa inválido');}
   const active=b.active===undefined?old.active:b.active;if(typeof active!=='boolean')fail('Estado de etapa inválido');
   if(old.active&&!active&&old.kind==='open'){
    const others=(await c.query("select count(*)::int as count from agency_pipeline_stages where organization_id=$1 and kind='open' and active and id<>$2",[org,key])).rows[0].count;
    if(!others)fail('Debe quedar al menos una etapa activa de oportunidades');
   }
   result={stage:(await c.query('update agency_pipeline_stages set label=$1,position=$2,active=$3,updated_at=now() where id=$4 and organization_id=$5 returning '+stageFields,[label,position,active,key,org])).rows[0]};
  }else if(req.method==='DELETE'&&key){
   const old=(await c.query('select * from agency_pipeline_stages where id=$1 and organization_id=$2 for update',[key,org])).rows[0];
   if(!old)fail('Etapa no encontrada',404);
   const used=(await c.query('select count(*)::int as count from agency_leads where organization_id=$1 and stage=$2',[org,old.slug])).rows[0].count;
   if(old.active&&old.kind==='open'){
    const others=(await c.query("select count(*)::int as count from agency_pipeline_stages where organization_id=$1 and kind='open' and active and id<>$2",[org,key])).rows[0].count;
    if(!others)fail('Debe quedar al menos una etapa activa de oportunidades');
   }
   if(used){
    await c.query('update agency_pipeline_stages set active=false,updated_at=now() where id=$1 and organization_id=$2',[key,org]);
    result={ok:true,deactivated:true,slug:old.slug};
   }else{
    if(old.active){
     const remaining=(await c.query('select count(*)::int as count from agency_pipeline_stages where organization_id=$1 and active and id<>$2',[org,key])).rows[0].count;
     if(!remaining)fail('Debe quedar al menos una etapa activa');
    }
    await c.query('delete from agency_pipeline_stages where id=$1 and organization_id=$2',[key,org]);
    result={ok:true,deleted:true};
   }
  }else fail('Método no permitido',405);
  await c.query('commit');transaction=false;send(res,status,result);
 }catch(error){
  if(transaction)await c.query('rollback');
  console.error(JSON.stringify({event:'pipeline_stages_error',path:url.pathname,status:error.status||500,code:error.code}));
  send(res,error.status||500,{error:error.status?error.message:'No se pudo completar la operación de etapas'});
 }finally{c?.release();}
 return true;
}
