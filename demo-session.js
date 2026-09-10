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
 const org=(await c.query("insert into organizations(slug,name,demo_owner_user_id,demo_source_id,demo_expires_at) values($1,'Agencia Horizonte',$2,$3,now()+interval '7 days') returning id",['demo-session-'+crypto.randomUUID(),userId,sourceId])).rows[0].id;
 await c.query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3)',[org,userId,source.role]);
 await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip','demo-fixture',true)",[String(userId)]);
 await seedPrivateDemo(c,org,userId);
 await c.query('insert into agency_demo_sessions(demo_key,user_id,organization_id) values($1,$2,$3)',[demoKey,userId,org]);
 return org;
}
export async function seedPrivateDemo(c,org,userId){
 const palette=['#560766','#355fb0','#15857b','#b47a12','#b04170'];
 const portrait=(label,index,person=false)=>'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="48" fill="${palette[index%5]}"/>${person?'<circle cx="128" cy="93" r="43" fill="#f6d4bd"/><path d="M43 256v-36a85 85 0 0 1 170 0v36" fill="#fff"/><path d="M86 91a44 44 0 0 1 84-15l-39-21-44 38" fill="#292130"/>':`<text x="128" y="154" text-anchor="middle" font-family="Arial,sans-serif" font-size="74" font-weight="700" fill="white">${label}</text>`}</svg>`).toString('base64');
 await c.query("insert into agency_settings(organization_id,legal_name,tax_id,address,phone,onboarding_completed) values($1,'Agencia Horizonte E.A.S.','80000000-0','Av. Mariscal López 120 · Asunción','+595 000 000000',true) on conflict do nothing",[org]);
 await c.query('insert into agency_exchange_rates(organization_id,rate_date,usd_to_pyg) values($1,current_date,7500),($1,current_date-1,7480)',[org]);
 const account=[];
 for(const [name,type,currency,institution,number,holder] of [['Caja de oficina','cash','PYG','','','Agencia Horizonte E.A.S.'],['Banco Continental · Caja de ahorro en guaraníes','bank','PYG','Banco Continental','310056630007','SCALE STRATEGY GROUP E.A.S.'],['Caja de ahorro en dólares','bank','USD','Banco Continental','010010000123','Agencia Horizonte E.A.S.']]){
  account.push((await c.query('insert into bank_accounts(organization_id,name,account_type,currency,balance,custodian_user_id,holder_name,institution,account_number) values($1,$2,$3,$4,0,$5,$6,$7,$8) returning id',[org,name,type,currency,userId,holder,institution,number])).rows[0].id);
 }
 const staff=[],people=[];
 let personIndex=0;
 for(const [name,job,salary,role] of [['Lucía Acosta','Dirección',6000000,'admin'],['Mateo Ríos','Editor audiovisual',3500000,'editor'],['Camila Vera','Administración',4000000,'finance'],['Nicolás Duarte','Comercial',2500000,'sales'],['Valentina Sol','Producción',3800000,'production']]){
  const email=`persona-${org}-${personIndex}@demo.example.invalid`;
  const person=(await c.query("insert into users(email,password_hash) values($1,'!fictional-demo-no-login') returning id",[email])).rows[0].id;
  await c.query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3)',[org,person,role]);
  people.push(person);
  staff.push((await c.query("insert into agency_collaborators(organization_id,user_id,full_name,email,photo_url,job_title,compensation_amount,payment_day,started_on,notes) values($1,$2,$3,$4,$5,$6,$7,5,current_date-90,'Honorarios mensuales. Coordinación de entregas en la reunión semanal.') returning id",[org,person,name,email,portrait('',personIndex++,true),job,salary])).rows[0].id);
 }
 const names=['Aurora Café','Bosque Hogar','Órbita Fitness','Nube Software','Luna Moda','Brisa Viajes','Prisma Diseño','Raíz Orgánica','Faro Inmuebles','Menta Salud','Sur Automotores','Pixel Academy','Alma Cocina','Ruta Outdoor','Nova Energía','Marea Cosmética','Roble Muebles','Cumbre Seguros','Punto Libros','Sol Pet'];
 const projects=[];
 for(let i=0;i<names.length;i++){
  const currency=i%5===3?'USD':'PYG',total=i%5===3?1200:((i%5)+3)*1000000;
  const client=(await c.query("insert into agency_clients(organization_id,name,email,notes,color_key,logo_url) values($1,$2,$3,'Enviar calendario de contenidos antes del inicio de cada mes.',$4,$5) returning id",[org,names[i],`cliente${i}@demo.example.invalid`,['violet','blue','teal','gold','rose'][i%5],portrait(names[i].split(' ').map(w=>w[0]).join(''),i)])).rows[0].id;
  const project=(await c.query('insert into agency_projects(organization_id,client_id,name,approval_levels,start_date,due_date,assigned_user_id) values($1,$2,$3,$4,current_date-7,current_date+21,$5) returning id',[org,client,'Campaña · '+names[i],i%3+1,i%2?userId:people[0]])).rows[0].id;
  projects.push(project);
  await c.query('insert into agency_project_assignees(organization_id,project_id,user_id) values($1,$2,$3)',[org,project,people[4]]);
  for(let j=0;j<4;j++){
   const stage=(i*4+j)%7,status=['blocked','to_record','recorded','editing','review','approved','published'][stage];
   // Production prepares/shoots, editing finishes, direction reviews; the visitor
   // owns some pieces too. Assignments never imply live presence or change roles.
   const assigned=(i*4+j)%5===0?userId:stage<=2?people[4]:stage===3?people[1]:people[0];
   const due=stage===6?-1:stage===1&&i<2?i+2:j-1;
   const order=(await c.query('insert into agency_work_orders(organization_id,project_id,title,description,status,due_date,assigned_user_id,estimated_hours) values($1,$2,$3,$4,$5,current_date+$6::int,$7,$8) returning id',[org,project,['Reel de lanzamiento','Historias de campaña','Carrusel de producto','Video de testimonio'][j],'Revisar el brief, preparar la pieza y adjuntar el enlace de Drive para aprobación.',status,due,assigned,2+j])).rows[0].id;
   await c.query('insert into agency_work_checklists(organization_id,work_order_id) values($1,$2)',[org,order]);
   const completed=[0,1,1,2,2,3,3][stage];
   for(const [step,label] of ['Validar brief y guion','Preparar y revisar la pieza','Confirmar aprobación final'].entries()){
    await c.query('insert into agency_work_checklist_items(organization_id,work_order_id,text,completed,created_by_user_id) values($1,$2,$3,$4,$5)',[org,order,label,step<completed,userId]);
   }
  }
  await c.query("insert into agency_project_comments(organization_id,project_id,author_user_id,body) values($1,$2,$3,'Brief validado. Revisar guion y compartir enlace antes de entregar.')",[org,project,userId]);
  const invoice=(await c.query("insert into agency_invoices(organization_id,client_id,number,total,currency,due_on,notes) values($1,$2,$3,$4,$5,current_date+$6::int,'Servicio mensual de estrategia y producción de contenidos.') returning id",[org,client,'FC-'+new Date().getFullYear()+'-'+String(i+1).padStart(4,'0'),total,currency,i===2?-10:10])).rows[0].id;
  if(i!==2)await c.query("insert into agency_payments(organization_id,invoice_id,account_id,amount,received_by_user_id,reference) values($1,$2,$3,$4,$5,'Cobro del servicio mensual')",[org,invoice,currency==='USD'?account[2]:account[0],i===1?total:total/2,userId]);
  const budget=(await c.query("insert into agency_budgets(organization_id,client_id,number,title,currency,subtotal,total,status,valid_until,notes) values($1,$2,$3,$4,$5,$6,$7,'draft',current_date+15,'Incluye planificación, producción y revisión. Vigencia de 15 días.') returning id",[org,client,'PRES-'+new Date().getFullYear()+'-'+String(i+1).padStart(4,'0'),'Plan mensual '+names[i],currency,total/1.1,total])).rows[0].id;
  await c.query('insert into agency_budget_items(budget_id,position,description,quantity,unit_price,total) values($1,0,$2,1,$3,$3)',[budget,'Producción de contenidos mensual',total/1.1]);
  await c.query('update agency_budgets set status=$1 where id=$2',[['draft','sent','accepted','rejected'][i%4],budget]);
  await c.query('insert into agency_leads(organization_id,name,stage,amount,currency,probability,notes,created_at) values($1,$2,$3,$4,$5,$6,$7,now()-$8::int*interval \'1 day\')',[org,'Prospecto '+names[i],['lead','contacted','proposal','negotiation','won'][i%5],total,currency,10+(i%5)*20,'Seguimiento de propuesta de gestión mensual de contenidos.',i%14]);
 }
 await c.query("insert into account_transfers(organization_id,from_account_id,to_account_id,amount,reference,created_by_user_id) values($1,$2,$3,1000000,'Depósito de caja en caja de ahorro',$4)",[org,account[0],account[1],userId]);
 await c.query("insert into agency_commissions(organization_id,collaborator_id,kind,beneficiary_name,amount,status,due_on) values($1,$2,'sales','Nicolás Duarte',150000,'approved',current_date+5)",[org,staff[3]]);
 for(const person of staff){
  await c.query("insert into agency_payouts(organization_id,collaborator_id,account_id,amount,paid_on,reference,created_by_user_id) values($1,$2,$3,250000,current_date-1,'Adelanto de honorarios del mes',$4)",[org,person,account[0],userId]);
  await c.query('update bank_accounts set balance=balance-250000 where id=$1 and organization_id=$2',[account[0],org]);
 }
 for(const [name,price]of [['Inicio',3000000],['Crecimiento',5000000],['Integral',8000000]])await c.query('insert into agency_plans(organization_id,name,items,notes) values($1,$2,$3,$4)',[org,name,JSON.stringify([{description:'Producción mensual',quantity:1,unitPrice:price}]),'Plan mensual de contenidos con revisión y seguimiento.']);
 await c.query("insert into agency_plans(organization_id,name,currency,items,notes) values($1,'Internacional','USD',$2,'Servicio internacional. Facturación en dólares.')",[org,JSON.stringify([{description:'Estrategia y producción de contenidos',quantity:1,unitPrice:1200}])]);
 // These catalogs must also exist for organizations created after migrations.
 const categories=new Map();
 for(const name of ['Cámara','Lente','Audio','Iluminación','Computación','Accesorio','Otro']){
  const category=(await c.query('insert into agency_inventory_categories(organization_id,name) values($1,$2) returning id',[org,name])).rows[0].id;
  categories.set(name,category);
 }
 const equipment=[];
 for(const [name,value,category,shelf]of [['Cámara',7000000,'Cámara','Armario A'],['Luces',2500000,'Iluminación','Estante B'],['Micrófono',1200000,'Audio','Armario A']]){
  equipment.push((await c.query("insert into agency_inventory(organization_id,name,category,category_id,value,status,storage_shelf,storage_row,notes) values($1,$2,$3,$4,$5,'available',$6,'1','Disponible para las producciones del equipo.') returning id",[org,name,category,categories.get(category),value,shelf])).rows[0].id);
 }
 // Planned shoots, not physical checkouts: equipment remains available now.
 // Reusing the camera on different days demonstrates bookings without overlap.
 for(const [index,itemIds] of [[equipment[0],equipment[1]],[equipment[0],equipment[2]]].entries()){
  const reservation=(await c.query("insert into agency_inventory_reservations(organization_id,project_id,title,starts_at,ends_at,created_by_user_id,return_user_id,notes) values($1,$2,$3,((now() at time zone 'America/Asuncion')::date+$4::int+time '09:00') at time zone 'America/Asuncion',((now() at time zone 'America/Asuncion')::date+$4::int+time '12:00') at time zone 'America/Asuncion',$5,$6,'Retirar al iniciar la grabación y devolver al terminar. Equipos todavía en depósito.') returning id",[org,projects[index],'Grabación · '+names[index],index+2,userId,people[4]])).rows[0].id;
  for(const person of [people[4],userId])await c.query('insert into agency_inventory_reservation_members(organization_id,reservation_id,user_id) values($1,$2,$3)',[org,reservation,person]);
  for(const item of itemIds)await c.query('insert into agency_inventory_reservation_items(organization_id,reservation_id,inventory_id) values($1,$2,$3)',[org,reservation,item]);
 }
 await c.query("insert into agency_internal_tasks(organization_id,title,description) values($1,'Preparar reunión de equipo','Revisar entregas de la semana, bloqueos y agenda de grabación.')",[org]);
 const archived=(await c.query("insert into agency_inventory(organization_id,name,category,category_id,value,storage_shelf,storage_row,notes) values($1,'Trípode de estudio','Accesorio',$2,150000,'Revisión técnica','1','Retirado del inventario activo; pendiente de revisión técnica.') returning id",[org,categories.get('Accesorio')])).rows[0].id;
 await c.query("insert into agency_archived_records(organization_id,kind,record_id,removed_by) values($1,'inventory',$2,$3)",[org,archived,userId]);
 // Rolling history includes the current and previous month, never fixed calendar dates.
 for(let day=0;day<60;day++)for(const [name,count]of [['page_view',day<30?18+(day%8):9+(day%5)],['mobile_view',day<30?10:5],['whatsapp_click',day%3+1]]){
  await c.query('insert into events(organization_id,name,metadata,event_date) select $1,$2,\'{"demo":true}\'::jsonb,current_date-$3::int from generate_series(1,$4::int)',[org,name,day,count]);
 }
}
