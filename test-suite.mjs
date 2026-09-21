import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {suite} from './agency-suite.js';
import {pipelineStages} from './pipeline-stages.js';
import {passwordAccess} from './password-access.js';
import {collaboratorAccess} from './collaborator-access.js';
import {budgetDocument} from './budget-document.js';
import {civilDate,zoneDate,zoneToday} from './business-time.js';
process.env.INVITE_LINK_SECRET??='test-invite-secret-fixture-32-chars-long';
const pg=new PGlite();await pg.exec(await fs.readFile('schema.sql','utf8'));
for(const name of ['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql'])await pg.exec(await fs.readFile('migrations/'+name,'utf8'));
const query=(sql,args)=>pg.query(sql,args),db={query,connect:async()=>({query,release(){}})};
await pg.exec(await fs.readFile('migrations/20260910_productivity.sql','utf8'));
await pg.exec(await fs.readFile('migrations/20260910_client_links.sql','utf8'));
for(const file of ['20260908_google_oauth.sql','20260910_profile_identity.sql','20260910_demo_sessions.sql','20260910_invite_links.sql','20260910_currencies.sql','20260910_company_currency.sql','20260910_global_identity.sql','20260916_identity_photo_removal.sql','20260914_role_permissions.sql','20260918_collaborator_role_and_project_archive.sql','20260919_collaborator_role_member_checks.sql'])await pg.exec(await fs.readFile('migrations/'+file,'utf8'));
await pg.exec(await fs.readFile('migrations/20260911_drive_links.sql','utf8'));
await pg.exec(await fs.readFile('migrations/20260910_project_assignees.sql','utf8'));
for(const file of ['20260914_salary_forecast.sql','20260914_client_commercial_lifecycle.sql','20260914_client_terms_and_planned_expenses.sql','20260910_work_checklists.sql','20260910_notifications.sql','20260913_ruc_collaboration.sql','20260914_production_traceability.sql','20260915_planned_expense_kind.sql','20260915_inventory_photos.sql','20260915_salary_override_signed.sql','20260919_pipeline_stages.sql','20260920_currency_widening.sql'])await pg.exec(await fs.readFile('migrations/'+file,'utf8'));
const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
const serverSource=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
assert(serverSource.indexOf('inventoryReservations({')<serverSource.indexOf('suite({'),'inventory routes are handled before the suite in server.js');
const other=(await query("insert into organizations(slug,name) values('suite-other','Other') returning id")).rows[0].id;
const uid=(await query("insert into users(email,password_hash) values('suite-owner@example.invalid','unused') returning id")).rows[0].id;
const viewer=(await query("insert into users(email,password_hash) values('suite-viewer@example.invalid','unused') returning id")).rows[0].id;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner'),($1,$3,'viewer')",[org,uid,viewer]);
const user={id:uid,organization_id:org,role:'owner',organization_name:'Scale'};
let resetToken='',sent=0;const grantedEmails=[];
async function call(path,method='GET',payload={},as=user,form=''){
 let result={status:0};const req={method,socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){yield form;}};
 const args={req,res:{writeHead(status,headers){result={status,headers};},end(content){result.content=content;}},url:new URL('https://test'+path),db,session:async()=>as,body:async()=>payload,send:(_,status,data)=>{result={status,...data};},sendInvitation:async()=>true,sendAccessGranted:async(email,organizationName,role)=>{grantedEmails.push({email,organizationName,role});return true;},sendReset:async(_,token)=>{resetToken=token;sent++;return true;}};
 const handled=path.startsWith('/api/agency/pipeline-stages')?await pipelineStages(args):path.startsWith('/api/auth/password')?await passwordAccess(args):await suite(args);assert.equal(handled,true);return result;
}
const client=(await query("insert into agency_clients(organization_id,name) values($1,'Client') returning id",[org])).rows[0].id;
const project=(await query("insert into agency_projects(organization_id,client_id,name,approval_levels) values($1,$2,'Project',2) returning id",[org,client])).rows[0].id;
const order=(await query("insert into agency_work_orders(organization_id,project_id,title,status) values($1,$2,'Video','review') returning id",[org,project])).rows[0].id;
assert.equal((await call(`/api/agency/clients/${client}`,'PATCH',{name:'Changed'})).record.name,'Changed');
assert.equal((await call(`/api/agency/clients/${client}`,'PATCH',{social_links:{website:'https://example.com',instagram:'https://www.instagram.com/example/',whatsapp:'https://wa.me/595981000000',other:[{label:'Catálogo',url:'https://example.com/catalogo'}]}})).status,200);
assert.equal((await call(`/api/agency/clients/${client}`,'PATCH',{name:'Renamed'})).record.social_links.website,'https://example.com');
assert.equal((await call(`/api/agency/clients/${client}`,'PATCH',{social_links:{website:'javascript:alert(1)'}})).status,400);
assert.equal((await call(`/api/agency/clients/${client}`,'PATCH',{social_links:{}},{...user,role:'editor'})).status,403);
assert.equal((await call(`/api/agency/clients/${client}`,'PATCH',{name:'Cross tenant'},{...user,organization_id:other})).status,404);
let linksResult=await call(`/api/agency/projects/${project}`,'PATCH',{drive_links:'https://drive.google.com/file/d/one\nhttps://drive.google.com/drive/folders/two'});assert.equal(linksResult.record.drive_url,'https://drive.google.com/file/d/one');assert.equal(linksResult.record.drive_links.length,2);
linksResult=await call(`/api/agency/work-orders/${order}`,'PATCH',{drive_links:'https://drive.google.com/file/d/order\nhttps://drive.google.com/drive/folders/assets'});assert.equal(linksResult.workOrder.drive_links.length,2);assert.equal(linksResult.workOrder.drive_url,'https://drive.google.com/file/d/order');
assert.equal((await call(`/api/agency/work-orders/${order}`,'PATCH',{drive_links:Array.from({length:11},(_,i)=>({url:`https://drive.google.com/${i}`}))})).status,400);
assert.equal((await call(`/api/agency/work-orders/${order}`,'PATCH',{status:'approved'})).status,400);
assert.equal((await call(`/api/agency/work-orders/${order}/approve`,'POST',{}, {...user,role:'editor'})).status,403);
assert.equal((await call(`/api/agency/work-orders/${order}/approve`,'POST')).status,200);
assert.equal((await call(`/api/agency/work-orders/${order}/approve`,'POST')).status,200);
assert.equal((await call(`/api/agency/work-orders/${order}/publish`,'POST')).status,200);
assert.equal((await call(`/api/agency/work-orders/${order}`,'PATCH',{status:'editing'}, {...user,role:'editor'})).workOrder.approval_step,0);
// Editar un proyecto exige `projects.edit`: ni el defecto de otro rol ni una concesión
// de `work-orders.manage` habilitan la edición (antes el gate usaba work-orders.manage).
assert.equal((await call(`/api/agency/projects/${project}`,'PATCH',{name:'Sales denied'},{...user,role:'sales'})).status,403,'sales lacks projects.edit by default');
assert.equal((await call(`/api/agency/projects/${project}`,'PATCH',{name:'Sales allowed'},{...user,role:'sales',capabilities:{'projects.edit':true}})).status,200,'the override grants the edit');
assert.equal((await call(`/api/agency/projects/${project}`,'PATCH',{name:'Editor denied'},{...user,role:'editor',capabilities:{'work-orders.manage':true}})).status,403,'work-orders.manage never grants project edits');
assert.equal((await call(`/api/agency/projects/${project}`,'PATCH',{name:'Editor allowed'},{...user,role:'editor',capabilities:{'projects.edit':true}})).status,200);
assert.equal((await call('/api/agency/dashboard','GET',{}, {...user,role:'sales'})).status,403);
assert.equal((await call(`/api/agency/members/${uid}`,'PATCH',{active:false})).status,400);
assert.equal((await call(`/api/agency/members/${viewer}`,'PATCH',{active:false})).status,200);
assert.equal(grantedEmails.length,0,'suspending a member never emails');
assert.equal((await call(`/api/agency/members/${viewer}`,'PATCH',{active:true})).status,200);
assert.equal(grantedEmails.length,1,'reactivating a member emails the access-granted notice');
assert.deepEqual(grantedEmails[0],{email:'suite-viewer@example.invalid',organizationName:'Scale',role:'viewer'});
assert.equal((await call(`/api/agency/members/${viewer}`,'PATCH',{role:'collaborator'})).status,200,'the collaborator role passes the membership check');
assert.equal((await query('select role from organization_members where organization_id=$1 and user_id=$2',[org,viewer])).rows[0].role,'collaborator');
await call(`/api/agency/members/${viewer}`,'PATCH',{active:false});
const access=await collaboratorAccess({query},{email:'suite-viewer@example.invalid',org,actorRole:'owner',active:true});assert.equal(access.status,'suspended');
let r=await call('/api/agency/leads','POST',{name:'Prospect',amount:1000,currency:'USD'});assert.equal(r.status,201);const lead=r.record.id;
const converted=await call(`/api/agency/leads/${lead}/convert`,'POST');assert.equal(converted.status,200);assert.equal((await call(`/api/agency/leads/${lead}/convert`,'POST')).clientId,converted.clientId);
assert.equal((await call('/api/agency/leads','GET',{}, {...user,organization_id:other})).records.length,0);
// Editable pipeline stages per company: active stages only, stable slugs and
// historical leads readable after a stage is deactivated.
const stageOrg=(await query("insert into organizations(slug,name) values('suite-stages','Stages') returning id")).rows[0].id;
const stageUser={...user,organization_id:stageOrg};
let stages=(await call('/api/agency/pipeline-stages','GET',{},stageUser)).stages;
assert.deepEqual(stages.map(s=>s.slug),['lead','contacted','proposal','negotiation','won','lost']);
assert.deepEqual(stages.map(s=>s.kind),['open','open','open','open','won','lost']);
let custom=(await call('/api/agency/pipeline-stages','POST',{label:'Visita técnica'},stageUser)).stage;
assert.equal(custom.slug,'visita-tecnica');assert.equal(custom.position,6);assert.equal(custom.active,true);
assert.equal((await call('/api/agency/pipeline-stages','POST',{label:'Visita técnica'},stageUser)).status,409,'duplicate labels cannot create two stages');
const stageLead=(await call('/api/agency/leads','POST',{name:'Etapa personalizada',stage:custom.slug},stageUser)).record;
assert.equal(stageLead.stage,'visita-tecnica');
const leadById=async id=>(await call('/api/agency/leads','GET',{},stageUser)).records.find(record=>String(record.id)===String(id));
assert.equal((await call(`/api/agency/pipeline-stages/${custom.id}`,'PATCH',{active:false},stageUser)).stage.active,false);
assert.equal((await leadById(stageLead.id)).stage,'visita-tecnica','historical leads keep their inactive slug');
assert.equal((await call('/api/agency/leads','POST',{name:'Etapa inactiva',stage:custom.slug},stageUser)).status,400,'inactive stages reject new leads');
assert.equal((await call(`/api/agency/leads/${stageLead.id}`,'PATCH',{name:'Sin tocar etapa'},stageUser)).status,200,'a PATCH without stage keeps the stored slug');
assert.equal((await call(`/api/agency/pipeline-stages/${custom.id}`,'PATCH',{slug:'otro'},stageUser)).status,409,'the slug is stable');
assert.equal((await call(`/api/agency/pipeline-stages/${custom.id}`,'PATCH',{label:'Visita a estudio'},stageUser)).stage.label,'Visita a estudio');
assert.equal((await call(`/api/agency/pipeline-stages/${custom.id}`,'DELETE',{},stageUser)).deactivated,true,'stages with opportunities are deactivated, never deleted');
const unusedStage=(await call('/api/agency/pipeline-stages','POST',{label:'Descartable'},stageUser)).stage;
assert.equal((await call(`/api/agency/pipeline-stages/${unusedStage.id}`,'DELETE',{},stageUser)).deleted,true,'unused stages can be removed');
const openStages=stages.filter(s=>s.kind==='open'&&s.active);
for(const stage of openStages.slice(0,-1))assert.equal((await call(`/api/agency/pipeline-stages/${stage.id}`,'PATCH',{active:false},stageUser)).status,200);
assert.equal((await call(`/api/agency/pipeline-stages/${openStages.at(-1).id}`,'PATCH',{active:false},stageUser)).status,400,'one open stage must stay active');
const closedKind=(await call('/api/agency/pipeline-stages','POST',{label:'Descartado',kind:'lost'},stageUser)).stage;
assert.equal((await call('/api/agency/leads','POST',{name:'Cerrado',stage:closedKind.slug},stageUser)).record.probability,0,'a lost-kind stage forces probability zero');
const wonStage=stages.find(s=>s.kind==='won');
await call(`/api/agency/pipeline-stages/${wonStage.id}`,'PATCH',{label:'Cerrado ganado'},stageUser);
const convertLead=(await call('/api/agency/leads','POST',{name:'Convertir',amount:10,currency:'USD'},stageUser)).record;
assert.equal((await call(`/api/agency/leads/${convertLead.id}/convert`,'POST',{},stageUser)).status,200);
const convertedStage=await leadById(convertLead.id);
assert.equal(convertedStage.stage,wonStage.slug,'conversion follows the company won stage');
assert.equal(convertedStage.probability,100);
assert.equal((await call(`/api/agency/pipeline-stages/${wonStage.id}`,'PATCH',{label:'Ajeno'},{...stageUser,organization_id:org})).status,404,'cross-tenant stage edits are refused');
assert.equal((await call('/api/agency/pipeline-stages','GET',{}, {...stageUser,role:'viewer'})).status,403);
assert.equal((await call('/api/agency/pipeline-stages','POST',{label:'Viewer'}, {...stageUser,role:'viewer'})).status,403);
// El inventario se escribe en inventory-reservations.js: el suite ya no reclama
// esas rutas (si lo hiciera, volvería a guardar la forma vieja sin category_id,
// ubicación ni valor de compra). Acá solo se necesita una fila para el tablero.
assert.equal(await suite({req:{method:'POST',socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://test/api/agency/inventory'),send:()=>{}}),false,'the suite never handles inventory routes');
await query("insert into agency_inventory(organization_id,name,value,currency) values($1,'Camera',2000,'USD')",[org]);
assert.equal((await call('/api/agency/plans','POST',{name:'Plan',items:[{description:'Video',quantity:2,unitPrice:100}],currency:'USD'})).status,201);
assert.equal((await call('/api/agency/plans','POST',{name:'Invalid',items:[]})).status,400);
assert.equal((await call('/api/agency/exchange-rates','POST',{rate_date:'2026-09-08',usd_to_pyg:7500})).status,200);
// La cotización revalida el mismo rango entero que la interfaz (G. 1.000 a G. 100.000).
for(const rate of [999,100001,1234.5,'7500.5',-7500,0])assert.equal((await call('/api/agency/exchange-rates','POST',{rate_date:'2026-09-09',usd_to_pyg:rate})).status,400,`rate ${rate} is rejected`);
assert.equal((await call('/api/agency/exchange-rates','POST',{rate_date:'2026-09-09',usd_to_pyg:1000})).status,200);
assert.equal((await call('/api/agency/exchange-rates','POST',{rate_date:'2026-09-10',usd_to_pyg:100000})).status,200);
assert.equal((await call('/api/agency/exchange-rates','POST',{rate_date:'2026-09-11',usd_to_pyg:'6000'})).status,200,'a numeric string inside the range stays accepted');
// La dirección acepta el límite documentado por la interfaz (400) y rechaza más.
assert.equal((await call('/api/agency/settings','PATCH',{address:'x'.repeat(400)})).status,200);
assert.equal((await call('/api/agency/settings','PATCH',{address:'x'.repeat(401)})).status,400);
assert.equal((await call('/api/agency/dashboard')).inventory[0].total,'2000.00');
await query("insert into agency_user_profiles(organization_id,user_id,full_name,photo_url) values($1,$2,'Autor local','https://example.invalid/actor.png')",[org,uid]);
const activity=await call('/api/agency/activity');assert.equal(activity.status,200);assert.ok(activity.records.length>=5);
const authored=activity.records.find(row=>row.actor===String(uid));assert.equal(authored.actor_name,'Autor local');assert.equal(authored.actor_photo_url,'https://example.invalid/actor.png');assert.equal(authored.actor_verified,true);
for(const role of ['owner','admin'])assert.equal((await call('/api/agency/activity','GET',{}, {...user,role})).status,200,`${role} ve la actividad`);
for(const role of ['viewer','finance','sales','production','editor','collaborator'])assert.equal((await call('/api/agency/activity','GET',{}, {...user,role})).status,403,`${role} no ve la actividad`);
assert.equal((await call('/api/agency/activity','GET',{}, {...user,role:'management'})).status,403,'gerencia no ve la actividad del equipo');
assert.equal((await call('/api/agency/activity','GET',{},null)).status,401);
assert.equal((await call('/api/agency/activity','GET',{}, {...user,organization_id:other})).records.length,0);
const token='a'.repeat(32);const budget=(await query("insert into agency_budgets(organization_id,client_id,number,title,currency,subtotal,total,public_token) values($1,$2,'Q-TEST','Quote','USD',200,220,$3) returning id",[org,client,token])).rows[0].id;
await query("insert into agency_budget_items(budget_id,position,description,quantity,unit_price,total) values($1,1,'Video',2,100,200)",[budget]);
assert.equal((await call('/p/'+token)).status,404);
assert.equal((await call(`/api/agency/budgets/${budget}/share`,'POST')).status,200);
r=await call('/p/'+token);assert.equal(r.status,200);assert.ok(r.content.includes('Q-TEST'));
assert.equal((await call('/p/'+token+'/respond','POST',{},null,'name=Customer&action=accept&revision=1')).status,303);
assert.equal((await call('/p/'+token+'/respond','POST',{},null,'name=Customer&action=accept&revision=1')).status,409);
assert.equal((await call(`/api/agency/budgets/${budget}`,'PATCH',{title:'Changed',items:[{description:'Something',quantity:1,unitPrice:1}]})).status,400);
const invoice=await call(`/api/agency/budgets/${budget}/invoice`,'POST');assert.equal(invoice.status,200);assert.equal((await call(`/api/agency/budgets/${budget}/invoice`,'POST')).invoice.id,invoice.invoice.id);
assert.equal((await call(`/api/agency/budgets/${budget}/revoke`,'POST')).status,200);assert.equal((await call('/p/'+token)).status,404);
const escaped=budgetDocument({number:'T',title:'<script>alert(1)</script>',organization_name:'Test',client_name:'Client',currency:'USD',subtotal:10,total:11,tax_rate:.1},[]);assert.ok(!escaped.includes('<script>'));assert.ok(escaped.includes('&lt;script&gt;'));
// El día de negocio es America/Asuncion: la validez del presupuesto no se
// compara contra UTC (un vencimiento de la tarde se leería como el día siguiente).
assert.equal(zoneDate('2026-09-21T02:59:00.000Z'),'2026-09-20','late evening in Asuncion stays on the same day');
assert.equal(zoneDate('2026-09-21T03:00:00.000Z'),'2026-09-21','midnight in Asuncion starts the next day');
assert.equal(zoneToday(new Date('2026-01-01T02:30:00.000Z')),'2025-12-31');
assert.equal(zoneDate('nope'),null);
// Las columnas `date` se leen como fecha civil: algunos drivers entregan
// medianoche UTC y otros medianoche local, y ninguno puede correr el día.
assert.equal(civilDate(new Date('2020-01-01T00:00:00Z')),'2020-01-01','UTC midnight dates keep their civil day');
assert.equal(civilDate(new Date(2020,0,1)),'2020-01-01','local midnight dates keep their civil day');
assert.equal(civilDate('2026-09-20'),'2026-09-20');
assert.equal(civilDate(null),null);
// users.role ya no nace con rol administrativo (issue #23).
assert.equal((await query("insert into users(email,password_hash) values('role-default-fixture@example.invalid','unused') returning role")).rows[0].role,'viewer','el default de users.role no es administrativo');
assert.equal((await query("select column_default from information_schema.columns where table_name='users' and column_name='role'")).rows[0].column_default,"'viewer'::text",'schema y migración dejan el mismo default');
const budgetSource=await fs.readFile(new URL('./budget-document.js',import.meta.url),'utf8');
assert.match(budgetSource,/const validUntil=civilDate\(b\.valid_until\)/,'budget validity reads the stored civil date');
assert.match(budgetSource,/validUntil>=zoneToday\(\)/,'budget validity uses the company day');
assert.match(budgetSource,/escape\(zoneDate\(b\.accepted_at\)\)/,'acceptance prints the company day');
// La respuesta pública se habilita el día de la empresa y se cierra al vencer.
const publicBudget={status:'sent',public_token:'fixture',revision:1,number:'T',title:'T',organization_name:'Test',client_name:'Client',currency:'USD',subtotal:10,total:11,tax_rate:.1};
const yesterday=zoneDate(new Date(Date.now()-86400000));
assert.match(budgetDocument({...publicBudget,valid_until:zoneToday()},[],{publicView:true}),/Aceptar presupuesto/,'a budget valid today still accepts the response');
assert.match(budgetDocument({...publicBudget,valid_until:zoneDate(new Date(Date.now()+86400000))},[],{publicView:true}),/Aceptar presupuesto/,'a budget valid tomorrow still accepts the response');
assert.doesNotMatch(budgetDocument({...publicBudget,valid_until:yesterday},[],{publicView:true}),/Aceptar presupuesto/,'a budget that expired yesterday no longer accepts the response');
const suiteSource=await fs.readFile(new URL('./agency-suite.js',import.meta.url),'utf8');
assert.match(suiteSource,/valid_until>="\+zoneTodaySql\+"/,'the public response compares against the company day');
const todayToken='c'.repeat(32);
await query("insert into agency_budgets(organization_id,client_id,number,title,currency,subtotal,total,public_token,share_enabled,status,valid_until) values($1,$2,'Q-TODAY','Today','USD',10,11,$3,true,'sent',$4::date)",[org,client,todayToken,zoneToday()]);
assert.equal((await call('/p/'+todayToken+'/respond','POST',{},null,'name=Customer&action=accept&revision=1')).status,303,'a quote valid today can still be accepted');
assert.equal((await call('/p/'+todayToken+'/respond','POST',{},null,'name=Customer&action=accept&revision=1')).status,409,'the same quote cannot be accepted twice');

r=await call('/api/auth/password/request','POST',{email:'unknown@example.invalid'});assert.equal(r.status,202);assert.equal(sent,0);
assert.equal((await call('/api/auth/password/request','POST',{email:'suite-owner@example.invalid'})).status,202);assert.equal(sent,1);assert.equal(resetToken.length,64);
assert.equal((await call('/api/auth/password/reset','POST',{token:resetToken,password:'NuevaClave!2026'})).status,200);
assert.equal((await call('/api/auth/password/reset','POST',{token:resetToken,password:'NuevaClave!2026'})).status,400);
// Lote de archivar/reactivar para clientes y proyectos.
const batchClient=(await query("insert into agency_clients(organization_id,name) values($1,'Batch client') returning id",[org])).rows[0].id;
const batchProject=(await query("insert into agency_projects(organization_id,client_id,name,approval_levels) values($1,$2,'Batch project',1) returning id",[org,batchClient])).rows[0].id;
r=await call('/api/agency/clients/batch','POST',{ids:[batchClient],archived:true});assert.equal(r.status,200);assert.equal(r.updated,1);
assert.equal((await call(`/api/agency/clients/${batchClient}`)).record.active,false,'the batch archives the client');
assert.equal((await call('/api/agency/clients/batch','POST',{ids:[batchClient],archived:false})).status,200);
assert.equal((await call(`/api/agency/clients/${batchClient}`)).record.active,true);
assert.equal((await call('/api/agency/projects/batch','POST',{ids:[batchProject],archived:true})).status,200);
assert.equal((await call('/api/agency/projects/batch','POST',{ids:['999999'],archived:true})).status,404,'every id must belong to the company');
assert.equal((await call('/api/agency/clients/batch','POST',{ids:[batchClient],archived:true},{...user,role:'viewer'})).status,403,'batch actions require the manage capability');
assert.equal((await call('/api/agency/clients/batch','POST',{ids:['abc'],archived:true})).status,400);
// El lote de proyectos responde a projects.edit y no a work-orders.manage:
// las capacidades se otorgan y revocan por separado desde el panel.
assert.equal((await call('/api/agency/projects/batch','POST',{ids:[batchProject],archived:true},{...user,role:'editor',capabilities:{'projects.edit':true,'work-orders.manage':false}})).status,200,'projects.edit authorizes the project batch');
assert.equal((await call('/api/agency/projects/batch','POST',{ids:[batchProject],archived:false},{...user,role:'editor',capabilities:{'projects.edit':false,'work-orders.manage':true}})).status,403,'work-orders.manage cannot archive projects');
assert.equal((await call('/api/agency/projects/batch','POST',{ids:[batchProject],archived:false},{...user,role:'editor',capabilities:{'projects.edit':true,'work-orders.manage':true}})).status,200);
await pg.close();console.log('PASS: approvals, member suspension, tenant isolation, pipeline conversion, plans, inventory, dashboard permissions, public quotes, invoice idempotency, audit and password reset');
