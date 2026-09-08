// One-off, explicitly requested maintenance. Never imported by server/startup.
import pg from 'pg';
import {isDeepStrictEqual} from 'node:util';
import {randomBytes} from 'node:crypto';
import bcrypt from 'bcryptjs';
export const tables=['agency_reconciliation_matches','agency_statement_lines','agency_content_reviews','agency_payment_reversals','agency_payouts','account_transfers','agency_payments','agency_referral_discounts','agency_commissions','agency_invoices','agency_budget_items','agency_budgets','agency_project_comments','agency_work_orders','agency_projects','agency_leads','agency_collaborators','agency_clients','agency_inventory','agency_plans','bank_accounts','agency_archived_records'];
const switches=[['agency_payments','agency_payments_sync'],['agency_payment_reversals','payment_reversal_sync'],['account_transfers','account_transfers_sync']];
const snapshotId='scale-operational-reset-20260908';
const where=t=>t==='agency_budget_items'?'budget_id in (select id from agency_budgets where organization_id=$1)':'organization_id=$1';
const normalized=value=>JSON.parse(JSON.stringify(value));
export async function capture(c,org){const data={};for(const t of tables)data[t]=normalized((await c.query(`select * from ${t} where ${where(t)} order by ${t==='agency_archived_records'?'kind,record_id':'id'}`,[org])).rows);return data;}
async function setup(c){await c.query(`create table if not exists scale_maintenance_snapshots(id text primary key,organization_id bigint not null references organizations(id),payload jsonb not null,created_at timestamptz not null default now(),applied_at timestamptz,restored_at timestamptz)`);}
async function lock(c){await c.query(`lock table ${tables.join(',')} in access exclusive mode`);}
async function toggle(c,enabled){for(const [table,trigger]of switches)await c.query(`alter table ${table} ${enabled?'enable':'disable'} trigger ${trigger}`);}
async function guard(c){const org=(await c.query('select id,slug,name from organizations where id=1 for update')).rows[0];if(org?.slug!=='scale'||org.name!=='Scale Strategy Group')throw Error('Target agency mismatch');}
export async function cleanScale(c,{restore=false}={}){
 await c.query('begin');
 try{
  await c.query("set local lock_timeout='10s'");await guard(c);await lock(c);await setup(c);
  await c.query("select set_config('app.current_user','maintenance:requested-by-Dario-20260908',true),set_config('app.current_ip','manual-hub-task',true)");
  const protectedBefore=normalized((await c.query('select * from organization_members order by organization_id,user_id')).rows);
  const otherBefore=await capture(c,22);
  const saved=(await c.query('select * from scale_maintenance_snapshots where id=$1',[snapshotId])).rows[0];
  if(!restore&&saved){await c.query('rollback');return {alreadyApplied:Boolean(saved.applied_at),restored:Boolean(saved.restored_at)};}
  const current=await capture(c,1);
  if(restore){
   if(!saved?.applied_at||saved.restored_at)throw Error('Snapshot not available for restore');
   if(Object.values(current).some(rows=>rows.length))throw Error('Refusing to overwrite new Scale data');
   await toggle(c,false);
   await c.query('alter table agency_payments disable trigger payment_insert_guard');
   await c.query('alter table account_transfers disable trigger transfer_insert_guard');
   for(const t of [...tables].reverse())if(saved.payload[t]?.length)await c.query(`insert into ${t} select * from jsonb_populate_recordset(null::${t},$1::jsonb)`,[JSON.stringify(saved.payload[t])]);
   await toggle(c,true);
   await c.query('alter table agency_payments enable trigger payment_insert_guard');
   await c.query('alter table account_transfers enable trigger transfer_insert_guard');
   if(!isDeepStrictEqual(await capture(c,1),saved.payload))throw Error('Restoration comparison failed');
   await c.query('update scale_maintenance_snapshots set restored_at=now() where id=$1',[snapshotId]);
  }else{
   await c.query('insert into scale_maintenance_snapshots(id,organization_id,payload) values($1,1,$2)',[snapshotId,JSON.stringify(current)]);
   const verified=(await c.query('select payload from scale_maintenance_snapshots where id=$1',[snapshotId])).rows[0].payload;
   if(!isDeepStrictEqual(verified,current))throw Error('Backup comparison failed');
   await toggle(c,false);
   for(const t of tables)await c.query(`delete from ${t} where ${where(t)}`,[1]);
   await toggle(c,true);
   if(Object.values(await capture(c,1)).some(rows=>rows.length))throw Error('Scale not empty');
   await c.query('update scale_maintenance_snapshots set applied_at=now() where id=$1',[snapshotId]);
  }
  if(!isDeepStrictEqual(await capture(c,22),otherBefore))throw Error('Demo changed during cleanup');
  if(!isDeepStrictEqual(normalized((await c.query('select * from organization_members order by organization_id,user_id')).rows),protectedBefore))throw Error('Access memberships changed');
  const disabled=(await c.query("select tgname from pg_trigger where not tgisinternal and tgenabled='D' and tgname in ('agency_payments_sync','payment_reversal_sync','account_transfers_sync')")).rows;
  if(disabled.length)throw Error('Financial controls were not restored');
  await c.query('commit');return {snapshot:snapshotId,restored:restore,counts:Object.fromEntries(Object.entries(current).map(([t,rows])=>[t,rows.length]))};
 }catch(e){await c.query('rollback');throw e;}
}
export async function seedDemo(c){
 await c.query('begin');
 try{
  const org=(await c.query('select id,slug from organizations where id=22 for update')).rows[0];
  if(org?.slug!=='scale-demo-controles-20260908')throw Error('Demo target mismatch');
  await setup(c);const key='scale-demo-enrichment-20260908';
  if((await c.query('select id from scale_maintenance_snapshots where id=$1',[key])).rows.length){await c.query('rollback');return{alreadySeeded:true};}
  await c.query("select set_config('app.current_user','maintenance:demo-fixtures',true),set_config('app.current_ip','manual-hub-task',true)");
  const realBefore=await capture(c,1);
  await c.query('insert into scale_maintenance_snapshots(id,organization_id,payload) values($1,22,$2)',[key,JSON.stringify(await capture(c,22))]);
  const people=[];
  for(const [i,name,role,job,salary]of [[0,'Lucía Acosta','owner','Dirección',6000000],[1,'Mateo Ríos','editor','Editor audiovisual',3500000],[2,'Camila Vera','finance','Administración',4000000],[3,'Nicolás Duarte','sales','Comercial',2500000],[4,'Valentina Sol','production','Productor',3800000]]){
   const email=`persona${i}@scale-demo.example.invalid`,hash=await bcrypt.hash(randomBytes(32).toString('hex'),10);
   const user=(await c.query('insert into users(email,password_hash) values($1,$2) returning id',[email,hash])).rows[0];
   await c.query('insert into organization_members(organization_id,user_id,role,active) values(22,$1,$2,true)',[user.id,role]);
   const p=(await c.query("insert into agency_collaborators(organization_id,user_id,full_name,email,job_title,compensation_amount,currency,payment_day,started_on,notes) values(22,$1,$2,$3,$4,$5,'PYG',5,current_date-180,'Persona ficticia; sin correo real ni invitación enviada.') returning id",[user.id,'Demo · '+name,email,job,salary])).rows[0];people.push({user:user.id,person:p.id});
  }
  const account=[];
  for(const [name,type,currency,owner]of [['Demo · Caja Lucía','cash','PYG',people[0].user],['Demo · Banco ficticio PYG','bank','PYG',people[2].user],['Demo · Tesorería USD (catálogo)','bank','USD',people[2].user]])account.push((await c.query('insert into bank_accounts(organization_id,name,account_type,currency,balance,custodian_user_id,holder_name) values(22,$1,$2,$3,0,$4,$5) returning id',[name,type,currency,owner,'Empresa ficticia de demostración'])).rows[0].id);
  const names=['Aurora Café','Bosque Hogar','Órbita Fitness','Nube Software','Luna Moda'];
  for(let i=0;i<names.length;i++){
   const currency=i===3?'USD':'PYG',total=i===3?1200:(i+3)*1000000;
   const client=(await c.query("insert into agency_clients(organization_id,name,email,notes) values(22,$1,$2,'Cliente ficticio para practicar; no contactar.') returning id",['Demo · '+names[i],`cliente${i}@scale-demo.example.invalid`])).rows[0];
   const project=(await c.query("insert into agency_projects(organization_id,client_id,name,approval_levels,start_date,due_date) values(22,$1,$2,$3,current_date-7,current_date+21) returning id",[client.id,'Demo · Campaña '+names[i],i%3+1])).rows[0];
   for(let j=0;j<4;j++)await c.query("insert into agency_work_orders(organization_id,project_id,title,description,status,due_date,assigned_user_id,estimated_hours) values(22,$1,$2,$3,$4,current_date+$5::int,$6,$7)",[project.id,['Reel de lanzamiento','Historias de campaña','Carrusel de producto','Video de testimonio'][j],'Ejemplo ficticio. Agregá un enlace de Drive propio si querés probar la entrega.',['blocked','to_record','recorded','editing','review','approved','published'][(i*4+j)%7],j-1,people[j%people.length].user,2+j]);
   await c.query("insert into agency_project_comments(organization_id,project_id,author_user_id,body) values(22,$1,$2,'Brief validado. Revisar guion y compartir enlace de Drive antes de la entrega; comentario de demostración.')",[project.id,people[4].user]);
   const invoice=(await c.query("insert into agency_invoices(organization_id,client_id,number,total,currency,due_on,notes) values(22,$1,$2,$3,$4,current_date+$5::int,'Comprobante ficticio, sin validez fiscal ni dinero real.') returning id",[client.id,'DEMO-PRO-'+(i+1),total,currency,i===2?-10:10])).rows[0];
   if(i!==2)await c.query("insert into agency_payments(organization_id,invoice_id,account_id,amount,received_by_user_id,reference) values(22,$1,$2,$3,$4,'Cobro ficticio de ejemplo')",[invoice.id,currency==='USD'?account[2]:account[0],i===1?total:total/2,people[0].user]);
   const budget=(await c.query("insert into agency_budgets(organization_id,client_id,number,title,currency,subtotal,total,status,valid_until,notes) values(22,$1,$2,$3,$4,$5,$6,'draft',current_date+15,'Propuesta ficticia; no está publicada.') returning id",[client.id,'DEMO-PROP-'+(i+1),'Demo · Plan mensual '+names[i],currency,total/1.1,total])).rows[0];
   await c.query('insert into agency_budget_items(budget_id,position,description,quantity,unit_price,total) values($1,0,$2,1,$3,$3)',[budget.id,'Producción y gestión de contenidos mensual',total/1.1]);
   await c.query("insert into agency_leads(organization_id,name,stage,amount,currency,probability,notes) values(22,$1,$2,$3,$4,$5,'Oportunidad ficticia')",['Demo · Prospecto '+names[i],['lead','contacted','proposal','negotiation','won'][i],total,currency,10+i*20]);
  }
  await c.query("insert into account_transfers(organization_id,from_account_id,to_account_id,amount,reference,created_by_user_id) values(22,$1,$2,1000000,'Demo · Depósito de caja al banco',$3)",[account[0],account[1],people[0].user]);
  await c.query("insert into agency_payouts(organization_id,collaborator_id,account_id,amount,paid_on,reference,created_by_user_id) values(22,$1,$2,500000,current_date,'Demo · Adelanto de honorarios',$3)",[people[1].person,account[1],people[2].user]);
  await c.query('update bank_accounts set balance=balance-500000 where id=$1 and organization_id=22',[account[1]]);
  await c.query("insert into agency_commissions(organization_id,collaborator_id,kind,beneficiary_name,amount,currency,status,due_on,notes) values(22,$1,'sales','Demo · Nicolás Duarte',150000,'PYG','approved',current_date+5,'Comisión ficticia pendiente de pago')",[people[3].person]);
  for(const [name,price]of [['Inicio',3000000],['Crecimiento',5000000],['Integral',8000000]])await c.query('insert into agency_plans(organization_id,name,items,notes) values(22,$1,$2,$3)',['Demo · '+name,JSON.stringify([{description:'Producción mensual de contenidos',quantity:1,unitPrice:price}]),'Plantilla ficticia, no es el pricing comercial de Scale.']);
  for(const [i,name,value]of [[0,'Cámara de producción',7000000],[1,'Kit de luces',2500000],[2,'Micrófono de estudio',1200000]])await c.query("insert into agency_inventory(organization_id,name,serial_number,category,value,status,custodian_user_id,notes) values(22,$1,$2,'Producción',$3,$4,$5,'Activo ficticio')",['Demo · '+name,'DEMO-PRO-'+i,value,i===0?'in_use':'available',people[4].user]);
  if(!isDeepStrictEqual(await capture(c,1),realBefore))throw Error('Real company changed by demo seed');
  await c.query('update scale_maintenance_snapshots set applied_at=now() where id=$1',[key]);await c.query('commit');return{clients:5,projects:5,orders:20,people:5,invoices:5,receipts:4,accounts:3,proposals:5,leads:5,plans:3,inventory:3};
 }catch(e){await c.query('rollback');throw e;}
}
if(process.argv[1]?.endsWith('/prepare-scale-data.mjs')){
 const c=new pg.Client({connectionString:process.env.DATABASE_URL});
 try{await c.connect();const mode=process.argv[2];let result;
  if(mode==='inspect')result={scale:Object.fromEntries(Object.entries(await capture(c,1)).map(([t,r])=>[t,r.length])),demo:Object.fromEntries(Object.entries(await capture(c,22)).map(([t,r])=>[t,r.length]))};
  else if(mode==='clear-scale-confirmed')result=await cleanScale(c);
  else if(mode==='restore-scale-confirmed')result=await cleanScale(c,{restore:true});
  else if(mode==='seed-demo-confirmed')result=await seedDemo(c);
  else throw Error('Explicit mode required');console.log(JSON.stringify({event:'scale_data_preparation',mode,result}));
 }catch(e){console.error(JSON.stringify({event:'scale_data_preparation_failed',code:e.code||'CHECK_FAILED',message:e.message}));process.exitCode=1;}finally{await c.end();}
}
