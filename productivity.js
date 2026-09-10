import {fail,text,id,optId,date,option,owned,link} from './suite-validation.js';
import {visibleRecord} from './record-lifecycle.js';
import {profilePhoto} from './media-policy.js';
const makers=['owner','admin','management','production','editor'];
const managers=['owner','admin','management','production'];
const finance=['owner','admin','finance'];
async function assignee(c,key,org){if(key&&!(await c.query('select 1 from organization_members where organization_id=$1 and user_id=$2 and active=true and removed_at is null',[org,key])).rows.length)fail('Responsable sin acceso activo a esta empresa');return key;}
export function templateItems(raw){
 if(!Array.isArray(raw)||!raw.length||raw.length>40)fail('Agregá entre 1 y 40 piezas');
 return raw.map(item=>{const title=text(item.title,160),day=Number(item.day),hours=Number(item.hours||0);if(title.length<2||!Number.isInteger(day)||day<1||day>31||!Number.isFinite(hours)||hours<0||hours>500)fail('Revisá título, día (1–31) y horas de las piezas');return{title,day,hours,checklist:text(item.checklist||'',2000)};});
}
export function monthDate(month,day){if(!/^\d{4}-\d{2}$/.test(month)||!date(month+'-01'))fail('Mes inválido');const [y,m]=month.split('-').map(Number);const last=new Date(Date.UTC(y,m,0)).getUTCDate();return month+'-'+String(Math.min(day,last)).padStart(2,'0');}
export async function productivity({req,res,url,db,session,body,send}){
 const match=url.pathname.match(/^\/api\/agency\/productivity\/(history|source-events|internal-tasks|profile|people|orders|batch|templates|clients)(?:\/(\d+))?(?:\/(comments|duplicate|generate))?$/);
 if(!match)return false;let c,tx=false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  const [,kind,key,action]=match,org=user.organization_id;
  if(kind!=='profile'&&req.method!=='GET'&&!(kind==='templates'?managers:makers).includes(user.role))fail('Sin permiso para esta acción',403);
  if(kind==='templates'&&!managers.includes(user.role))fail('Sin permiso para plantillas',403);
  if(kind==='source-events'&&req.method!=='GET'&&!['owner','admin'].includes(user.role))fail('Solo administración puede importar actividad',403);
  c=await db.connect();await c.query('begin');tx=true;
  await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);
  let result,status=200;
  if(kind==='history'&&req.method==='GET'){
   const person=optId(url.searchParams.get('userId'));
   if(person&&person!==String(user.id)&&!managers.includes(user.role))fail('Sin permiso para historial de otra persona',403);
   const actor=person||(!managers.includes(user.role)?String(user.id):null);
   result={records:(await c.query(`select a.id,a.table_name,a.action,coalesce(up.full_name,u.email,a.actor) as actor_name,a.created_at,
    coalesce(a.after_state->>'title',a.before_state->>'title',a.after_state->>'name',a.before_state->>'name','Comentario') as title,
    a.before_state->>'status' as previous_status,a.after_state->>'status' as next_status
    from agency_operation_audit a left join users u on u.id::text=a.actor left join agency_user_profiles up on up.user_id=u.id and up.organization_id=a.organization_id
    where a.organization_id=$1 and ($2::text is null or a.actor=$2) and a.table_name in ('agency_work_orders','agency_projects','agency_order_comments','agency_project_comments','agency_internal_tasks') order by a.id desc limit 100`,[org,actor])).rows};
  }else if(kind==='source-events'){
   if(req.method==='GET')result={records:(await c.query('select id,source_url,source_author,body,occurred_at from agency_source_events where organization_id=$1 order by occurred_at desc,id desc limit 200',[org])).rows};
   else if(req.method==='POST'){
    const b=await body(req);if(!Array.isArray(b.events)||b.events.length>100)fail('Máximo 100 eventos por importación');let created=0;
    for(const e of b.events){const at=new Date(e.occurred_at);if(!Number.isFinite(at.getTime()))fail('Fecha de origen inválida');created+=(await c.query('insert into agency_source_events(organization_id,source_key,source_url,source_author,body,occurred_at,imported_by) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning id',[org,text(e.source_key,160),link(e.source_url),text(e.source_author,120),text(e.body,4000),at.toISOString(),user.id])).rows.length;}result={created};
   }else fail('Método no permitido',405);
  }else if(kind==='internal-tasks'){
   if(req.method==='GET')result={records:(await c.query('select * from agency_internal_tasks where organization_id=$1 order by due_date asc nulls last,id desc limit 200',[org])).rows};
   else if(req.method==='POST'&&!key){const b=await body(req),title=text(b.title,160);if(title.length<2)fail('Ingresá el título');result={record:(await c.query('insert into agency_internal_tasks(organization_id,title,description,due_date,source_key) values($1,$2,$3,$4,$5) on conflict(organization_id,source_key) do update set source_key=excluded.source_key returning *',[org,title,text(b.description||'',4000),date(b.due_date),b.source_key?text(b.source_key,160):null])).rows[0]};status=201;}
   else if(req.method==='PATCH'&&key){const old=await owned(c,'agency_internal_tasks',key,org),b={...old,...await body(req)},person=await assignee(c,optId(b.assigned_user_id),org);result={record:(await c.query('update agency_internal_tasks set title=$1,description=$2,status=$3,due_date=$4,assigned_user_id=$5,updated_at=now() where id=$6 returning *',[text(b.title,160),text(b.description,4000),option(b.status,['pending','in_progress','done']),date(b.due_date),person,key])).rows[0]};}
   else fail('Método no permitido',405);
  }else if(kind==='profile'&&!key&&!action){
   const current=(await c.query('select full_name,photo_url from agency_user_profiles where user_id=$1 and organization_id=$2',[user.id,org])).rows[0]||{full_name:'',photo_url:null};
   if(req.method==='GET')result={profile:{...current,email:user.email,role:user.role}};
   else if(req.method==='PATCH'){
    const incoming=await body(req);if(Object.keys(incoming).some(k=>!['full_name','photo_url'].includes(k)))fail('Solo podés modificar tu nombre y foto');
    const b={...current,...incoming},name=text(b.full_name,120);if(name.length<2)fail('Ingresá tu nombre completo');
    if(incoming.photo_url && !String(incoming.photo_url).startsWith('data:image/'))fail('Subí una foto JPG, PNG o WebP');
    const photo=Object.hasOwn(incoming,'photo_url')?await profilePhoto(incoming.photo_url):current.photo_url;
    result={profile:(await c.query('insert into agency_user_profiles(user_id,organization_id,full_name,photo_url) values($1,$2,$3,$4) on conflict(user_id,organization_id) do update set full_name=excluded.full_name,photo_url=excluded.photo_url,updated_at=now() returning full_name,photo_url',[user.id,org,name,photo])).rows[0]};
   }else fail('Método no permitido',405);
  }else if(kind==='people'&&req.method==='GET'){
   result={people:(await c.query('select u.id,u.email,p.full_name,p.photo_url from organization_members m join users u on u.id=m.user_id left join agency_user_profiles p on p.user_id=u.id and p.organization_id=m.organization_id where m.organization_id=$1 and m.active=true and m.removed_at is null order by coalesce(p.full_name,u.email)',[org])).rows};
  }else if(kind==='orders'&&key){
   const order=await owned(c,'agency_work_orders',key,org);
   if(req.method==='GET'&&!action){
    const identity=(await c.query('select c.name as client_name,c.logo_url as client_logo_url,c.color_key as client_color_key from agency_projects p join agency_clients c on c.id=p.client_id where p.id=$1 and p.organization_id=$2',[order.project_id,org])).rows[0]||{};
    const history=(await c.query("select a.id,a.action,a.created_at,coalesce(u.email,a.actor) as actor_name,a.before_state->>'status' as previous_status,a.after_state->>'status' as next_status from agency_operation_audit a left join users u on u.id::text=a.actor where a.organization_id=$1 and a.table_name='agency_work_orders' and coalesce(a.after_state->>'id',a.before_state->>'id')=$2 order by a.id desc limit 100",[org,String(key)])).rows;
    result={order:{...order,...identity},history,comments:(await c.query('select c.id,c.body,c.created_at,u.email as author_email from agency_order_comments c left join users u on u.id=c.author_user_id where c.organization_id=$1 and c.work_order_id=$2 order by c.id desc limit 100',[org,key])).rows};
   }
   else if(req.method==='POST'&&action==='comments'){
    const b=await body(req),content=text(b.body,2000);if(!content)fail('Escribí un comentario');
    result={comment:(await c.query('insert into agency_order_comments(organization_id,work_order_id,author_user_id,body) values($1,$2,$3,$4) returning *',[org,key,user.id,content])).rows[0]};status=201;
   }else if(req.method==='POST'&&action==='duplicate'){
    result={order:(await c.query("insert into agency_work_orders(organization_id,project_id,title,description,status,estimated_hours) values($1,$2,$3,$4,'to_record',$5) returning *",[org,order.project_id,text(order.title.slice(0,150)+' · copia',160),order.description,order.estimated_hours])).rows[0]};status=201;
   }else fail('Método no permitido',405);
  }else if(kind==='batch'&&req.method==='POST'){
   const b=await body(req);if(!Array.isArray(b.ids)||!b.ids.length||b.ids.length>100)fail('Seleccioná entre 1 y 100 piezas');
   const ids=[...new Set(b.ids.map(id))].sort((a,b)=>Number(a)-Number(b));
   const records=[];for(const key of ids)records.push(await owned(c,'agency_work_orders',key,org));
   const change=b.change||{};if(!['status','assigned_user_id','due_date'].some(k=>k in change))fail('Elegí un cambio');
   if('status'in change)option(change.status,['blocked','to_record','recorded','editing','review']);
   const person='assigned_user_id'in change?await assignee(c,optId(change.assigned_user_id),org):null;
   const due='due_date'in change?date(change.due_date):null;
   for(const record of records){
    if(!b.versions||new Date(b.versions[record.id]).getTime()!==new Date(record.updated_at).getTime())fail('Una pieza cambió. Actualizá la lista antes de aplicar el lote.',409);
    if(['approved','published'].includes(record.status))fail('El lote no modifica piezas aprobadas o publicadas. Revisalas individualmente.',409);
    await c.query('update agency_work_orders set status=$1,assigned_user_id=$2,due_date=$3,approval_step=$4,updated_at=now() where id=$5',[change.status??record.status,'assigned_user_id'in change?person:record.assigned_user_id,'due_date'in change?due:record.due_date,change.status&&change.status!==record.status?0:record.approval_step,record.id]);
   }result={updated:records.length};
  }else if(kind==='templates'){
   if(req.method==='GET'&&!key)result={templates:(await c.query('select * from agency_work_templates where organization_id=$1 order by id desc',[org])).rows};
   else if(req.method==='POST'&&!key){const b=await body(req),name=text(b.name,120);if(name.length<2)fail('Nombrá la plantilla');result={template:(await c.query('insert into agency_work_templates(organization_id,name,items,created_by) values($1,$2,$3,$4) returning *',[org,name,JSON.stringify(templateItems(b.items)),user.id])).rows[0]};status=201;}
   else if(req.method==='POST'&&action==='generate'){
    const template=(await c.query('select * from agency_work_templates where id=$1 and organization_id=$2 for update',[key,org])).rows[0];if(!template)fail('Plantilla no encontrada',404);
    const b=await body(req),project=await owned(c,'agency_projects',b.project_id,org),month=monthDate(b.month,1),person=await assignee(c,optId(b.assigned_user_id),org);
    const run=(await c.query('insert into agency_template_runs(organization_id,template_id,project_id,month,created_by) values($1,$2,$3,$4,$5) on conflict do nothing returning id',[org,key,project.id,month,user.id])).rows[0];
    if(!run)result={created:0,alreadyGenerated:true};
    else{const items=templateItems(template.items);for(const item of items)await c.query("insert into agency_work_orders(organization_id,project_id,title,description,status,due_date,estimated_hours,assigned_user_id,template_run_id) values($1,$2,$3,$4,'to_record',$5,$6,$7,$8)",[org,project.id,item.title,item.checklist,monthDate(b.month,item.day),item.hours,person,run.id]);result={created:items.length,alreadyGenerated:false};status=201;}
   }else fail('Método no permitido',405);
  }else if(kind==='clients'&&key&&req.method==='GET'){
   const client=await owned(c,'agency_clients',key,org);
   const projects=(await c.query(`select p.* from agency_projects p where p.client_id=$1 and p.organization_id=$2 and ${visibleRecord('p','projects')} order by p.id desc`,[key,org])).rows;
   const orders=(await c.query(`select o.* from agency_work_orders o join agency_projects p on p.id=o.project_id where p.client_id=$1 and o.organization_id=$2 and ${visibleRecord('o','work-orders')} and ${visibleRecord('p','projects')} order by o.updated_at desc limit 100`,[key,org])).rows;
   result={client,projects,orders,financeAllowed:finance.includes(user.role)};
   if(finance.includes(user.role)){
    result.invoices=(await c.query('select id,number,currency,total,paid_amount,due_on from agency_invoices where organization_id=$1 and client_id=$2 order by id desc limit 100',[org,key])).rows;
    result.payments=(await c.query('select p.id,p.amount,p.received_on,a.name as account_name,a.currency,u.email as received_by_email from agency_payments p join agency_invoices i on i.id=p.invoice_id join bank_accounts a on a.id=p.account_id left join users u on u.id=p.received_by_user_id where p.organization_id=$1 and i.client_id=$2 order by p.id desc limit 100',[org,key])).rows;
   }
   if([...finance,'management','sales'].includes(user.role))result.budgets=(await c.query(`select b.id,b.title,b.number,b.status,b.currency,b.total from agency_budgets b where b.organization_id=$1 and b.client_id=$2 and ${visibleRecord('b','budgets')} order by b.id desc limit 100`,[org,key])).rows;
  }else fail('Método no permitido',405);
  await c.query('commit');tx=false;send(res,status,result);return true;
 }catch(error){if(tx)await c.query('rollback');console.error(JSON.stringify({event:'productivity_error',path:url.pathname,status:error.status||500,message:error.status?error.message:'unexpected'}));send(res,error.status||500,{error:error.status?error.message:'No se pudo completar la operación'});return true;}finally{c?.release();}
}
