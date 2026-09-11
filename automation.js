import {fail,id,optId,date,owned} from './suite-validation.js';
import {attributeActors} from './actor-identity.js';
import {templateItems,monthDate} from './productivity.js';
import {notificationEmail} from './notifications.js';
import {visibleRecord} from './record-lifecycle.js';
const managers=['owner','admin','management','production'];
export async function automationApi({req,res,url,db,session,body,send}){
 const match=url.pathname.match(/^\/api\/agency\/schedules(?:\/(\d+))?$/);if(!match)return false;let c;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);if(!managers.includes(user.role))fail('Sin permiso para automatizaciones',403);
  c=await db.connect();await c.query('begin');await c.query("select set_config('app.current_user',$1,true)",[String(user.id)]);let result;
  if(req.method==='GET'&&!match[1])result={schedules:(await c.query('select s.*,t.name as template_name,p.name as project_name from agency_recurring_plans s join agency_work_templates t on t.id=s.template_id join agency_projects p on p.id=s.project_id where s.organization_id=$1 order by s.id desc',[user.organization_id])).rows};
  else if(req.method==='POST'&&!match[1]){
   if(user.demo_owner_user_id)fail('El Demo permite generar manualmente; los envíos y tareas automáticas se activan en tu agencia.');
   const b=await body(req),template=id(b.template_id),project=id(b.project_id),person=optId(b.assigned_user_id),month=date(b.next_month);
   if(!month||!/^\d{4}-\d{2}-01$/.test(String(b.next_month)))fail('Elegí el primer día del mes de inicio');
   if(!(await c.query('select id from agency_work_templates where id=$1 and organization_id=$2',[template,user.organization_id])).rows.length)fail('Plantilla no encontrada',404);
   await owned(c,'agency_projects',project,user.organization_id);
   if(person&&!(await c.query('select 1 from organization_members where organization_id=$1 and user_id=$2 and active and removed_at is null',[user.organization_id,person])).rows.length)fail('Responsable sin acceso');
   result={schedule:(await c.query('insert into agency_recurring_plans(organization_id,template_id,project_id,assigned_user_id,created_by,next_month) values($1,$2,$3,$4,$5,$6) on conflict(organization_id,template_id,project_id) do update set assigned_user_id=excluded.assigned_user_id,created_by=excluded.created_by,next_month=excluded.next_month,active=true returning *',[user.organization_id,template,project,person,user.id,month])).rows[0]};
  }else if(req.method==='PATCH'&&match[1]){const b=await body(req);if(typeof b.active!=='boolean')fail('Estado inválido');const r=await c.query('update agency_recurring_plans set active=$1 where id=$2 and organization_id=$3 returning id',[b.active,match[1],user.organization_id]);if(!r.rows.length)fail('Programación no encontrada',404);result={ok:true};}
  else fail('Método no permitido',405);
  await attributeActors(c,user.organization_id,[{rows:result.schedules||result.schedule,userId:'created_by'}]);
  await c.query('commit');send(res,200,result);return true;
 }catch(e){if(c)await c.query('rollback');console.error(JSON.stringify({event:'schedule_error',status:e.status||500}));send(res,e.status||500,{error:e.status?e.message:'No se pudo guardar la programación'});return true;}finally{c?.release();}
}
export async function runMonthly(c){
 const plans=(await c.query(`select s.*,t.items from agency_recurring_plans s join agency_work_templates t on t.id=s.template_id and t.organization_id=s.organization_id join organizations org on org.id=s.organization_id join organization_members m on m.organization_id=s.organization_id and m.user_id=s.created_by join agency_projects p on p.id=s.project_id and p.organization_id=s.organization_id where s.active and org.active and org.demo_owner_user_id is null and m.active and m.removed_at is null and m.role=any($1) and p.status='active' and ${visibleRecord('p','projects')} and s.next_month<=date_trunc('month',now() at time zone 'America/Asuncion')::date order by s.id limit 30 for update of s skip locked`,[managers])).rows;
 let created=0;
 const month=(await c.query("select to_char(now() at time zone 'America/Asuncion','YYYY-MM') as month")).rows[0].month;
 for(const s of plans){
  if(s.assigned_user_id&&!(await c.query('select 1 from organization_members where organization_id=$1 and user_id=$2 and active and removed_at is null',[s.organization_id,s.assigned_user_id])).rows.length)continue;
  await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip','monthly-automation',true)",[String(s.created_by)]);
  const run=(await c.query('insert into agency_template_runs(organization_id,template_id,project_id,month,created_by) values($1,$2,$3,$4,$5) on conflict do nothing returning id',[s.organization_id,s.template_id,s.project_id,month+'-01',s.created_by])).rows[0];
  if(run)for(const item of templateItems(s.items)){await c.query("insert into agency_work_orders(organization_id,project_id,title,description,status,due_date,estimated_hours,assigned_user_id,template_run_id) values($1,$2,$3,$4,'to_record',$5,$6,$7,$8)",[s.organization_id,s.project_id,item.title,item.checklist,monthDate(month,item.day),item.hours,s.assigned_user_id,run.id]);created++;}
  await c.query("update agency_recurring_plans set next_month=($1::date+interval '1 month')::date where id=$2",[month+'-01',s.id]);
 }
 return created;
}
export async function enqueueDue(c){
 await c.query("select set_config('app.current_user','system:due-reminders',true)");
 await c.query(`select enqueue_agency_notification(o.organization_id,o.assigned_user_id,'due','Entrega pendiente: '||o.title,'La pieza vence hoy o está atrasada. Revisá el estado y la fecha.',o.id,o.project_id,'due:'||o.id||':'||o.due_date||':'||to_char(now() at time zone 'America/Asuncion','YYYY-MM-DD')) from agency_work_orders o join agency_projects p on p.id=o.project_id where o.status not in ('approved','published') and o.due_date<=(now() at time zone 'America/Asuncion')::date and o.assigned_user_id is not null and ${visibleRecord('o','work-orders')} and ${visibleRecord('p','projects')} order by o.id limit 1000`);
}
export async function deliverNotifications(db,{apiKey,from,appUrl,fetcher=fetch}){
 if(!apiKey)return 0;let sent=0;
 for(let i=0;i<20;i++){
  const c=await db.connect();try{
   await c.query('begin');await c.query("select set_config('app.current_user','system:notifications',true),set_config('app.current_ip','notification-worker',true)");
   const n=(await c.query("select n.*,u.email,org.name as organization_name,coalesce(p.email_enabled,false) as email_enabled,case n.kind when 'assignment' then coalesce(p.assignment,true) when 'comment' then coalesce(p.comment,true) else coalesce(p.due,true) end as kind_enabled,m.active as member_active,m.removed_at,org.active as org_active,org.demo_owner_user_id from agency_notifications n join users u on u.id=n.user_id join organizations org on org.id=n.organization_id join organization_members m on m.user_id=n.user_id and m.organization_id=n.organization_id left join agency_notification_preferences p on p.user_id=n.user_id and p.organization_id=n.organization_id where n.email_status='pending' and n.next_attempt_at<=now() order by n.id limit 1 for update of n skip locked")).rows[0];
   if(!n){await c.query('commit');break;}
   if(n.read_at||!n.email_enabled||!n.kind_enabled||!n.member_active||n.removed_at||!n.org_active||n.demo_owner_user_id||n.email.endsWith('.invalid')||Date.now()-new Date(n.created_at).getTime()>23*3600000){
    await c.query("update agency_notifications set email_status='skipped' where id=$1",[n.id]);await c.query('commit');continue;
   }
   try{
    const r=await fetcher('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','Idempotency-Key':'scale-notification-'+n.id},body:JSON.stringify({from,to:[n.email],...notificationEmail(n,appUrl)})});
    if(!r.ok)throw Error('Provider rejected');
    await c.query("update agency_notifications set email_status='sent',email_attempts=email_attempts+1 where id=$1",[n.id]);sent++;
   }catch{
    await c.query("update agency_notifications set email_attempts=email_attempts+1,email_status=case when email_attempts>=4 then 'failed' else 'pending' end,next_attempt_at=now()+interval '5 minutes'*power(2,email_attempts) where id=$1",[n.id]);
   }
   await c.query('commit');
  }catch{await c.query('rollback');console.error(JSON.stringify({event:'notification_delivery_error'}));}finally{c.release();}
 }
 return sent;
}
export function startAutomation(db,mail){
 let running=false;
 const tick=async()=>{if(running)return;running=true;const c=await db.connect();try{await c.query('begin');const lock=(await c.query("select pg_try_advisory_xact_lock(hashtextextended('scale-automation',0)) as locked")).rows[0].locked;if(lock){await runMonthly(c);await enqueueDue(c);}await c.query('commit');await deliverNotifications(db,mail);}catch{await c.query('rollback');console.error(JSON.stringify({event:'automation_tick_error'}));}finally{c.release();running=false;}};
 const timer=setInterval(()=>{void tick().catch(()=>{running=false;});},60000);timer.unref();void tick().catch(()=>{running=false;});return()=>clearInterval(timer);
}
