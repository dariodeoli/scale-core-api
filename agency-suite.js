import crypto from 'node:crypto';
import {fail,text,id,optId,option,amount,date,email,link,items,owned} from './suite-validation.js';
import {budgetDocument,renderBudgetPdf} from './budget-document.js';
import {ensureClientApproval} from './content-review.js';
import {budgetSections} from './budget-sections.js';
import {visibleRecord} from './record-lifecycle.js';
import {clientColor,clientLogo} from './client-identity.js';
import {clientLinks} from './client-links.js';
const admin=['owner','admin'], commercial=[...admin,'management','finance','sales'], production=[...admin,'management','production'];
const roles=[...admin,'management','finance','sales','production','editor','viewer'];
const stages=['lead','contacted','proposal','negotiation','won','lost'];
async function member(c,key,org){if(key&&!(await c.query('select 1 from organization_members where user_id=$1 and organization_id=$2 and active=true',[key,org])).rows.length)fail('La persona no tiene acceso activo a esta empresa');}
async function document(c,budgetId,org){const b=(await c.query('select b.*,c.name as client_name,o.name as organization_name,s.tax_id from agency_budgets b join agency_clients c on c.id=b.client_id join organizations o on o.id=b.organization_id left join agency_settings s on s.organization_id=o.id where b.id=$1 and b.organization_id=$2',[budgetId,org])).rows[0];if(!b)fail('Presupuesto no encontrado',404);return{budget:b,items:(await c.query('select * from agency_budget_items where budget_id=$1 order by position',[b.id])).rows};}
export async function suite({req,res,url,db,session,body,send,sendInvitation}){
 const publicMatch=url.pathname.match(/^\/p\/([A-Za-z0-9_-]{16,128})(?:\/(pdf|respond))?$/);
 const m=url.pathname.match(/^\/api\/agency\/(leads|inventory|plans|activity|dashboard|settings|exchange-rates|members|clients|projects|work-orders|budgets)(?:\/(\d+))?(?:\/(convert|resend|approve|publish|pdf|share|revoke|invoice))?$/);
 if(!publicMatch&&(!m||['members','clients','projects','work-orders','budgets'].includes(m[1])&&!m[2]))return false;
 let c,transaction=false;
 try{
  const user=publicMatch?null:await session(req);if(!publicMatch&&!user)fail('No autenticado',401);
  c=await db.connect();
  if(publicMatch){
   await c.query('begin');transaction=true;
   const b=(await c.query('select id,organization_id from agency_budgets where public_token=$1 and share_enabled=true for update',[publicMatch[1]])).rows[0];if(!b)fail('Este enlace no está disponible',404);
   const d=await document(c,b.id,b.organization_id);
   if(publicMatch[2]==='respond'&&req.method==='POST'){
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4000)fail('Formulario demasiado largo');}
    const form=new URLSearchParams(raw),name=text(form.get('name')||'',120),action=option(form.get('action'),['accept','reject']);if(name.length<2)fail('Ingresá tu nombre');
    const revision=Number(form.get('revision'));if(!Number.isInteger(revision)||revision<1)fail('Recargá la propuesta antes de responder',409);
    await c.query("select set_config('app.current_user','budget-link',true),set_config('app.current_ip',$1,true)",[req.socket.remoteAddress||'']);
    const result=await c.query("update agency_budgets set status=$1,accepted_by=$2,accepted_at=now(),updated_at=now() where id=$3 and revision=$4 and status='sent' and share_enabled=true and (valid_until is null or valid_until>=current_date) returning id",[action==='accept'?'accepted':'rejected',name,b.id,revision]);if(!result.rows.length)fail('La propuesta cambió, ya fue respondida o venció. Recargá la página.',409);
    await c.query('commit');transaction=false;res.writeHead(303,{Location:`/p/${publicMatch[1]}`});res.end();return true;
   }
   if(req.method!=='GET'||publicMatch[2]==='respond')fail('Método no permitido',405);
   const html=budgetDocument(d.budget,d.items,{publicView:true,pdf:publicMatch[2]==='pdf'});
   await c.query('commit');transaction=false;
   if(publicMatch[2]==='pdf'){const pdf=await renderBudgetPdf(html);res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${d.budget.number}.pdf"`,'Cache-Control':'no-store'});res.end(pdf);}
   else{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);}return true;
  }
  const org=user.organization_id,kind=m[1],key=m[2],action=m[3];
  const permitted=kind==='members'||kind==='activity'||kind==='settings'?admin:kind==='inventory'?req.method==='GET'?[...production,'finance','editor','viewer']:[...production,'finance']:['clients','projects','work-orders'].includes(kind)?req.method==='GET'?roles:kind==='clients'?[...admin,'management','sales']:kind==='work-orders'&&!action?[...production,'editor']:production:commercial;
  if(!permitted.includes(user.role))fail('Tu rol no permite esta operación',403);
  if(kind==='dashboard'&&!['owner','admin','finance'].includes(user.role))fail('Tu rol no permite ver saldos',403);
  await c.query('begin');transaction=true;await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);
  let result,status=200;
  if(kind==='members'){
   await c.query('select id from organizations where id=$1 for update',[org]);
   const current=(await c.query('select m.*,u.email from organization_members m join users u on u.id=m.user_id where m.user_id=$1 and m.organization_id=$2 and m.removed_at is null for update of m',[key,org])).rows[0];if(!current)fail('Integrante no encontrado',404);
   if(action==='resend'&&req.method==='POST'){if(!current.active)fail('Reactivá el acceso antes de invitar');await c.query('commit');transaction=false;const emailSent=await sendInvitation(current.email,user.organization_name,current.role).catch(()=>false);send(res,200,{emailSent});return true;}
   if(req.method!=='PATCH'||action)fail('Método no permitido',405);
   const b=await body(req),role=option(b.role??current.role,roles),active=b.active??current.active;
   if(typeof active!=='boolean')fail('Estado inválido');
   if(BigInt(key)===BigInt(user.id)&&(role!==current.role||!active))fail('No podés quitarte tu propio acceso');
   if(user.role!=='owner'&&(current.role==='owner'||role==='owner'))fail('Solo el propietario puede cambiar este rol',403);
   if(current.role==='owner'&&(!active||role!=='owner')){const n=await c.query("select count(*)::int as count from organization_members where organization_id=$1 and role='owner' and active=true",[org]);if(n.rows[0].count<=1)fail('Debe quedar al menos un propietario activo');}
   await c.query('update organization_members set role=$1,active=$2 where user_id=$3 and organization_id=$4',[role,active,key,org]);await c.query('delete from sessions where user_id=$1 and organization_id=$2',[key,org]);result={ok:true};
  }else if(kind==='clients'||kind==='projects'||kind==='work-orders'){
   const table={clients:'agency_clients',projects:'agency_projects','work-orders':'agency_work_orders'}[kind],old=await owned(c,table,key,org);
   if(req.method==='GET'){
    let identity={};
    if(kind==='projects')identity=(await c.query('select name as client_name,logo_url as client_logo_url,color_key as client_color_key from agency_clients where id=$1 and organization_id=$2',[old.client_id,org])).rows[0]||{};
    if(kind==='work-orders')identity=(await c.query('select c.name as client_name,c.logo_url as client_logo_url,c.color_key as client_color_key from agency_projects p join agency_clients c on c.id=p.client_id where p.id=$1 and p.organization_id=$2',[old.project_id,org])).rows[0]||{};
    result={record:{...old,...identity}};
   }
   else if(action&&kind==='work-orders'&&req.method==='POST'){
    const project=await owned(c,'agency_projects',old.project_id,org);
    if(action==='approve'){if(old.status!=='review')fail('La pieza debe estar en revisión');const step=old.approval_step+1;await c.query("update agency_work_orders set approval_step=$1,status=$2,updated_at=now() where id=$3",[step,step>=project.approval_levels?'approved':'review',key]);}
    else if(action==='publish'){if(old.status!=='approved')fail('Primero aprobá la pieza');await ensureClientApproval(c,old);await c.query("update agency_work_orders set status='published',updated_at=now() where id=$1",[key]);}else fail('Acción inválida');result={ok:true};
   }else if(req.method==='PATCH'&&!action){const incoming=await body(req),b={...old,...incoming};
    if(kind==='clients'&&Object.hasOwn(old,'lifecycle_status')){
     const state=option(incoming.lifecycle_status??(Object.hasOwn(incoming,'active')?(incoming.active===false?'inactive':'active'):old.lifecycle_status),['active','paused','cancelled','expired','inactive']);
     b.active=state==='active';
     await c.query('update agency_clients set lifecycle_status=$1 where id=$2 and organization_id=$3',[state,key,org]);
    }
    if(kind==='clients'){const name=text(b.name,120);if(name.length<2)fail('Ingresá el nombre');const logo=b.logo_url===old.logo_url?old.logo_url:await clientLogo(b.logo_url),color=clientColor(b.color_key??'violet');result={record:(await c.query('update agency_clients set name=$1,email=$2,phone=$3,notes=$4,legal_name=$5,tax_id=$6,active=$7,logo_url=$8,color_key=$9,social_links=$11,updated_at=now() where id=$10 returning *',[name,email(b.email),text(b.phone||'',50),text(b.notes||''),text(b.legal_name||'',160),text(b.tax_id||'',60),b.active!==false,logo,color,key,JSON.stringify(clientLinks(b.social_links))])).rows[0]};}
    if(kind==='projects'){const name=text(b.name,160),levels=Number(b.approval_levels);if(name.length<2||![1,2,3].includes(levels))fail('Proyecto inválido');result={record:(await c.query('update agency_projects set name=$1,drive_url=$2,status=$3,start_date=$4,due_date=$5,approval_levels=$6,updated_at=now() where id=$7 returning *',[name,link(b.drive_url),option(b.status,['active','paused','completed','cancelled']),date(b.start_date),date(b.due_date),levels,key])).rows[0]};}
    if(kind==='work-orders'){
     const state=option(b.status,['blocked','to_record','recorded','editing','review','approved','published']);let step=old.approval_step;
     if(state!==old.status){
      if(state==='published')await ensureClientApproval(c,old);
      if(['approved','published'].includes(state)){if(!production.includes(user.role))fail('Solo gerencia o producción puede aprobar',403);const project=await owned(c,'agency_projects',old.project_id,org);if(state==='approved'&&(old.status!=='review'||old.approval_step+1<project.approval_levels))fail('Completá los niveles de aprobación desde el detalle');if(state==='published'&&old.status!=='approved')fail('Primero aprobá la pieza');step=project.approval_levels;}
      else step=0;
     }
     const assignee=optId(b.assigned_user_id);await member(c,assignee,org);const title=text(b.title,160);if(title.length<2)fail('Ingresá el título');const record=(await c.query('update agency_work_orders set title=$1,description=$2,drive_url=$3,due_date=$4,assigned_user_id=$5,estimated_hours=$6,actual_hours=$7,status=$8,approval_step=$9,updated_at=now() where id=$10 returning *',[title,text(b.description||''),link(b.drive_url),date(b.due_date),assignee,amount(b.estimated_hours||0),amount(b.actual_hours||0),state,step,key])).rows[0];result={record,workOrder:record};
    }
   }else fail('Método no permitido',405);
  }else if(kind==='plans'||kind==='inventory'||kind==='leads'){
   const table={plans:'agency_plans',inventory:'agency_inventory',leads:'agency_leads'}[kind];
   if(req.method==='GET')result={records:(await c.query(`select r.* from ${table} r where organization_id=$1 and ${visibleRecord('r',kind)} order by id desc`,[org])).rows};
   else if(kind==='leads'&&action==='convert'&&key&&req.method==='POST'){const lead=await owned(c,table,key,org);if(lead.client_id)result={clientId:lead.client_id};else{const client=(await c.query('insert into agency_clients(organization_id,name,email,phone,notes) values($1,$2,$3,$4,$5) returning id',[org,lead.name,lead.email,lead.phone,lead.notes])).rows[0];await c.query("update agency_leads set stage='won',probability=100,client_id=$1,updated_at=now() where id=$2",[client.id,key]);result={clientId:client.id};}}
   else if((req.method==='POST'&&!key)||(req.method==='PATCH'&&key&&!action)){
    const old=key?await owned(c,table,key,org):{},b={...old,...await body(req)},name=text(b.name,160);if(name.length<2)fail('Ingresá el nombre');
    let columns,values;
    if(kind==='plans'){columns=['name','currency','items','notes','active'];values=[name,option(b.currency||'PYG',['PYG','USD']),JSON.stringify(items(b.items)),text(b.notes||''),b.active!==false];}
    if(kind==='inventory'){const custodian=optId(b.custodian_user_id);await member(c,custodian,org);columns=['name','category','serial_number','custodian_user_id','value','currency','status','acquired_on','notes'];values=[name,text(b.category||'',80),text(b.serial_number||'',120),custodian,amount(b.value||0),option(b.currency||'PYG',['PYG','USD']),option(b.status||'available',['available','in_use','maintenance','retired']),date(b.acquired_on),text(b.notes||'')];}
    if(kind==='leads'){const stage=option(b.stage||'lead',stages),probability=stage==='won'?100:stage==='lost'?0:Number(b.probability??10);if(!Number.isInteger(probability)||probability<0||probability>100)fail('Probabilidad de 0 a 100');columns=['name','email','phone','stage','amount','currency','probability','notes'];values=[name,email(b.email),text(b.phone||'',50),stage,amount(b.amount||0),option(b.currency||'PYG',['PYG','USD']),probability,text(b.notes||'')];}
    const query=key?`update ${table} set ${columns.map((n,i)=>`${n}=$${i+1}`).join(',')} where id=$${values.length+1} returning *`:`insert into ${table}(${columns.join(',')},organization_id) values(${values.map((_,i)=>`$${i+1}`).join(',')},$${values.length+1}) returning *`;
    result={record:(await c.query(query,[...values,key||org])).rows[0]};status=key?200:201;
   }else fail('Método no permitido',405);
  }else if(kind==='budgets'){
   const b=await owned(c,'agency_budgets',key,org);
   if(req.method==='GET'){result=await document(c,key,org);if(action==='pdf'){await c.query('commit');transaction=false;const pdf=await renderBudgetPdf(budgetDocument(result.budget,result.items,{pdf:true}));res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${b.number}.pdf"`,'Cache-Control':'no-store'});res.end(pdf);return true;}}
   else if(req.method==='POST'&&['share','revoke','invoice'].includes(action)){
    if(action==='share'){if(['rejected','expired'].includes(b.status))fail('Creá una nueva propuesta para volver a compartir');await c.query("update agency_budgets set share_enabled=true,status=case when status='draft' then 'sent' else status end where id=$1",[key]);result={url:`https://app.scaleparaguay.com/p/${b.public_token}`};}
    if(action==='revoke'){await c.query('update agency_budgets set share_enabled=false where id=$1',[key]);result={ok:true};}
    if(action==='invoice'){if(b.status!=='accepted')fail('El presupuesto debe estar aceptado');let invoice=(await c.query('select * from agency_invoices where budget_id=$1 and organization_id=$2',[key,org])).rows[0];if(!invoice){const number=`F-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;invoice=(await c.query('insert into agency_invoices(organization_id,client_id,budget_id,number,currency,total) values($1,$2,$3,$4,$5,$6) returning *',[org,b.client_id,key,number,b.currency,b.total])).rows[0];}result={invoice};}
   }else if(req.method==='PATCH'&&!action){if(b.status==='accepted')fail('Una propuesta aceptada no se puede modificar');const incoming=await body(req),sections=budgetSections(incoming.sections??b.sections),list=items(incoming.items),title=text(incoming.title,160);if(title.length<2)fail('Ingresá el título');const subtotal=amount(list.reduce((s,i)=>s+i.total,0)),taxRate=Number(incoming.tax_rate??b.tax_rate);if(![0,.05,.1].includes(taxRate))fail('IVA inválido');await c.query('update agency_budgets set title=$1,currency=$2,subtotal=$3,total=$4,tax_rate=$5,notes=$6,valid_until=$7,revision=revision+1,sections=$9,updated_at=now() where id=$8',[title,option(incoming.currency||b.currency,['PYG','USD']),subtotal,amount(subtotal*(1+taxRate)),taxRate,text(incoming.notes||''),date(incoming.valid_until),key,JSON.stringify(sections)]);await c.query('delete from agency_budget_items where budget_id=$1',[key]);for(const [i,row] of list.entries())await c.query('insert into agency_budget_items(budget_id,position,description,quantity,unit_price,total) values($1,$2,$3,$4,$5,$6)',[key,i+1,row.description,row.quantity,row.unitPrice,row.total]);result=await document(c,key,org);}
   else fail('Método no permitido',405);
  }else if(kind==='activity'&&req.method==='GET'){
   result={records:(await c.query("select id,table_name,action as operation,coalesce(after_state->>'id',after_state->>'user_id',before_state->>'id',after_state->>'record_id',before_state->>'record_id') as record_id,actor,created_at from agency_operation_audit where organization_id=$1 order by id desc limit 100",[org])).rows};
  }else if(kind==='dashboard'&&req.method==='GET'){
   result={cash:(await c.query('select currency,sum(balance) as total from bank_accounts where organization_id=$1 and active=true group by currency',[org])).rows,receivables:(await c.query("select currency,sum(total-paid_amount) as total from agency_invoices where organization_id=$1 and status not in ('draft','cancelled') group by currency",[org])).rows,inventory:(await c.query("select currency,sum(value) as total from agency_inventory where organization_id=$1 and status<>'retired' group by currency",[org])).rows,collections:(await c.query("select a.currency,sum(p.amount) as total from agency_cash_movements p join bank_accounts a on a.id=p.account_id where p.organization_id=$1 and p.movement_type in ('payment','reversal') and p.booked_on>=date_trunc('month',current_date) group by a.currency",[org])).rows,alerts:(await c.query(`select 'work_order' as type,o.id,o.title as name,o.due_date::text as due from agency_work_orders o join agency_projects p on p.id=o.project_id join agency_clients c on c.id=p.client_id where o.organization_id=$1 and o.due_date<current_date and o.status not in ('approved','published') and ${visibleRecord('o','work-orders')} and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')} union all select 'invoice',id,number,due_on::text from agency_invoices where organization_id=$1 and due_on<current_date and total>paid_amount and status not in ('draft','cancelled') order by due limit 30`,[org])).rows};
  }else if(kind==='settings'){
   if(req.method==='GET')result={settings:(await c.query('select o.name,s.* from organizations o left join agency_settings s on s.organization_id=o.id where o.id=$1',[org])).rows[0]};
   else if(req.method==='PATCH'){const b=await body(req),name=text(b.name,160);if(name.length<2)fail('Ingresá el nombre');await c.query('update organizations set name=$1 where id=$2',[name,org]);await c.query('insert into agency_settings(organization_id,legal_name,tax_id,address,phone,onboarding_completed) values($1,$2,$3,$4,$5,$6) on conflict(organization_id) do update set legal_name=excluded.legal_name,tax_id=excluded.tax_id,address=excluded.address,phone=excluded.phone,onboarding_completed=excluded.onboarding_completed',[org,text(b.legal_name||'',160),text(b.tax_id||'',60),text(b.address||'',300),text(b.phone||'',50),b.onboarding_completed===true]);result={ok:true};}else fail('Método no permitido',405);
  }else if(kind==='exchange-rates'){
   if(req.method==='GET')result={records:(await c.query('select * from agency_exchange_rates where organization_id=$1 order by rate_date desc limit 90',[org])).rows};
   else if(req.method==='POST'){const b=await body(req),rate=amount(b.usd_to_pyg),on=date(b.rate_date);if(!rate||!on)fail('Fecha y cotización requeridas');await c.query('insert into agency_exchange_rates values($1,$2,$3) on conflict(organization_id,rate_date) do update set usd_to_pyg=excluded.usd_to_pyg',[org,on,rate]);result={ok:true};}else fail('Método no permitido',405);
  }else fail('Método no permitido',405);
  await c.query('commit');transaction=false;send(res,status,result);return true;
 }catch(e){if(transaction)await c.query('rollback');console.error(JSON.stringify({event:'suite_error',path:url.pathname,status:e.status||500,code:e.code}));send(res,e.status||500,{error:e.status?e.message:'No se pudo completar la operación'});return true;}finally{c?.release();}
}
