import crypto from 'node:crypto';
const templateSlug='scale-demo-controles-20260908';
// A real agency owner can open a personal fixture without membership in the shared template.
export async function privateDemoEntry(c,userId){
 return (await c.query(`select d.id,d.slug,d.name,'owner' as role from organizations d
  where d.slug=$2 and d.active=true
  and exists(select 1 from organization_members m join organizations o on o.id=m.organization_id
   where m.user_id=$1 and m.role='owner' and m.active=true and m.removed_at is null and o.active=true and o.demo_owner_user_id is null and o.slug<>$2)
  and not exists(select 1 from organization_members m where m.user_id=$1 and m.organization_id=d.id and (m.active=false or m.removed_at is not null))`,[userId,templateSlug])).rows[0]||null;
}
// Called within the switch transaction. Source membership is checked here too.
export async function demoOrganization(c,{userId,sourceId,demoKey}){
 let source=(await c.query('select o.id,o.slug,m.role from organizations o join organization_members m on m.organization_id=o.id where o.id=$1 and m.user_id=$2 and m.active=true and m.removed_at is null and o.active=true',[sourceId,userId])).rows[0];
 if(!source){const demo=await privateDemoEntry(c,userId);if(demo&&String(demo.id)===String(sourceId))source=demo;}
 if(!source)throw Object.assign(Error('No pertenecés a esa empresa'),{status:403});
 if(source.slug!==templateSlug)return sourceId;
 await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))",['demo:'+demoKey+':'+userId]);
 const existing=(await c.query('select organization_id from agency_demo_sessions where demo_key=$1 and user_id=$2',[demoKey,userId])).rows[0];
 if(existing)return existing.organization_id;
 const org=(await c.query("insert into organizations(slug,name,demo_owner_user_id,demo_source_id,demo_expires_at) values($1,'Demo · Tu sesión privada (sin dinero real)',$2,$3,now()+interval '7 days') returning id",['demo-session-'+crypto.randomUUID(),userId,sourceId])).rows[0].id;
 await c.query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3)',[org,userId,source.role]);
 await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip','demo-fixture',true)",[String(userId)]);
 await seedPrivateDemo(c,org,userId);
 await c.query('insert into agency_demo_sessions(demo_key,user_id,organization_id) values($1,$2,$3)',[demoKey,userId,org]);
 return org;
}
export async function seedPrivateDemo(c,org,userId){
 const account=[];
 for(const [name,type,currency] of [['Caja Lucía','cash','PYG'],['Banco de ejemplo','bank','PYG'],['Cuenta USD','bank','USD']]){
  account.push((await c.query('insert into bank_accounts(organization_id,name,account_type,currency,balance,custodian_user_id,holder_name) values($1,$2,$3,$4,0,$5,$6) returning id',[org,'Demo · '+name,type,currency,userId,'Titular ficticio'])).rows[0].id);
 }
 const staff=[];
 for(const [name,job,salary] of [['Lucía Acosta','Dirección',6000000],['Mateo Ríos','Editor audiovisual',3500000],['Camila Vera','Administración',4000000],['Nicolás Duarte','Comercial',2500000],['Valentina Sol','Producción',3800000]]){
  staff.push((await c.query("insert into agency_collaborators(organization_id,full_name,job_title,compensation_amount,payment_day,started_on,notes) values($1,$2,$3,$4,5,current_date-180,'Persona ficticia. Sin correo ni acceso real.') returning id",[org,name,job,salary])).rows[0].id);
 }
 const names=['Aurora Café','Bosque Hogar','Órbita Fitness','Nube Software','Luna Moda'];
 for(let i=0;i<names.length;i++){
  const currency=i===3?'USD':'PYG',total=i===3?1200:(i+3)*1000000;
  const client=(await c.query("insert into agency_clients(organization_id,name,email,notes,color_key) values($1,$2,$3,'Cliente ficticio; no contactar.',$4) returning id",[org,names[i],`cliente${i}@demo.example.invalid`,['violet','blue','teal','gold','rose'][i]])).rows[0].id;
  const project=(await c.query('insert into agency_projects(organization_id,client_id,name,approval_levels,start_date,due_date) values($1,$2,$3,$4,current_date-7,current_date+21) returning id',[org,client,'Campaña · '+names[i],i%3+1])).rows[0].id;
  for(let j=0;j<4;j++)await c.query('insert into agency_work_orders(organization_id,project_id,title,description,status,due_date,assigned_user_id,estimated_hours) values($1,$2,$3,$4,$5,current_date+$6::int,$7,$8)',[org,project,['Reel de lanzamiento','Historias de campaña','Carrusel de producto','Video de testimonio'][j],'Ejemplo editable. Agregá un enlace de Drive para practicar.',['blocked','to_record','recorded','editing','review','approved','published'][(i*4+j)%7],j-1,userId,2+j]);
  await c.query("insert into agency_project_comments(organization_id,project_id,author_user_id,body) values($1,$2,$3,'Brief ficticio validado. Revisar guion y compartir enlace antes de entregar.')",[org,project,userId]);
  const invoice=(await c.query("insert into agency_invoices(organization_id,client_id,number,total,currency,due_on,notes) values($1,$2,$3,$4,$5,current_date+$6::int,'Ejemplo sin validez fiscal.') returning id",[org,client,'DEMO-'+(i+1),total,currency,i===2?-10:10])).rows[0].id;
  if(i!==2)await c.query("insert into agency_payments(organization_id,invoice_id,account_id,amount,received_by_user_id,reference) values($1,$2,$3,$4,$5,'Cobro ficticio')",[org,invoice,currency==='USD'?account[2]:account[0],i===1?total:total/2,userId]);
  const budget=(await c.query("insert into agency_budgets(organization_id,client_id,number,title,currency,subtotal,total,status,valid_until,notes) values($1,$2,$3,$4,$5,$6,$7,'draft',current_date+15,'Propuesta ficticia, no publicada.') returning id",[org,client,'DEMO-PROP-'+(i+1),'Plan mensual '+names[i],currency,total/1.1,total])).rows[0].id;
  await c.query('insert into agency_budget_items(budget_id,position,description,quantity,unit_price,total) values($1,0,$2,1,$3,$3)',[budget,'Producción de contenidos mensual',total/1.1]);
  await c.query('insert into agency_leads(organization_id,name,stage,amount,currency,probability,notes) values($1,$2,$3,$4,$5,$6,$7)',[org,'Prospecto '+names[i],['lead','contacted','proposal','negotiation','won'][i],total,currency,10+i*20,'Oportunidad ficticia']);
 }
 await c.query("insert into account_transfers(organization_id,from_account_id,to_account_id,amount,reference,created_by_user_id) values($1,$2,$3,1000000,'Depósito ficticio',$4)",[org,account[0],account[1],userId]);
 await c.query("insert into agency_commissions(organization_id,collaborator_id,kind,beneficiary_name,amount,status,due_on) values($1,$2,'sales','Nicolás Duarte',150000,'approved',current_date+5)",[org,staff[3]]);
 for(const [name,price]of [['Inicio',3000000],['Crecimiento',5000000],['Integral',8000000]])await c.query('insert into agency_plans(organization_id,name,items,notes) values($1,$2,$3,$4)',[org,name,JSON.stringify([{description:'Producción mensual',quantity:1,unitPrice:price}]),'Ejemplo, no pricing oficial.']);
 for(const [name,value]of [['Cámara',7000000],['Luces',2500000],['Micrófono',1200000]])await c.query("insert into agency_inventory(organization_id,name,category,value,status,notes) values($1,$2,'Producción',$3,'available','Equipo ficticio')",[org,name,value]);
 await c.query("insert into agency_internal_tasks(organization_id,title,description) values($1,'Preparar reunión de equipo','Tarea interna de demostración')",[org]);
}
