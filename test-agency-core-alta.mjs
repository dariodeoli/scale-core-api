import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {PGlite} from '@electric-sql/pglite';
import {budgetSections} from './budget-sections.js';
import {roleCan} from './permissions.js';
import {ensurePersonalIdentity} from './identity-session.js';
import {visibleRecord} from './record-lifecycle.js';
import {suite} from './agency-suite.js';
import {currencies} from './currencies.js';
import {amount,date as validDate,email as normalizedEmail,fail,items as validItems,option,phone as normalizedPhone,text} from './suite-validation.js';
import {clientColor,clientLogo} from './client-identity.js';
import {assertUniqueClientRuc} from './ruc-lookup.js';

// Issue #21: el alta (POST) de clientes y presupuestos en agency-core.js tiene
// que usar la misma validación, los mismos límites y el mismo redondeo que la
// edición (PATCH del suite). Antes el alta aceptaba largos y fechas que la
// edición después rechazaba. Este test ejecuta los cuerpos reales de las rutas
// contra una base PGlite y verifica la paridad en los dos sentidos.
const core=await fs.readFile(new URL('./agency-core.js',import.meta.url),'utf8');
const server=await fs.readFile(new URL('./server.js',import.meta.url),'utf8');
function between(text,start,end){
 const a=text.indexOf(start),b=text.indexOf(end,a+start.length);
 assert(a>=0&&b>a,`Anchor missing: ${start}`);
 assert.equal(text.indexOf(start,a+start.length),-1,`Ambiguous anchor: ${start}`);
 return text.slice(a,b);
}
const routes=[
 between(core,"    if (url.pathname === '/api/agency/clients' && req.method === 'POST') {","    if (url.pathname === '/api/agency/projects' && req.method === 'GET') {"),
 between(core,"    if (url.pathname === '/api/agency/budgets' && req.method === 'POST') {","    if (url.pathname === '/api/agency/accounts' && req.method === 'GET') {")
].join('\n');
const helpers=between(server,'const send =','const cookie =')+between(server,'const parseCookies =','const id =')+between(server,'const sessionCache =','async function session(req) {')+between(server,'async function session(req) {','function security(');
const pg=new PGlite();
try{
 await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
 for(const name of ['20260908_treasury_ledger.sql','20260908_google_oauth.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260908_daily_controls.sql','20260910_productivity.sql','20260910_profile_identity.sql','20260910_demo_sessions.sql','20260910_invite_links.sql','20260910_client_links.sql','20260910_currencies.sql','20260910_company_currency.sql','20260910_global_identity.sql','20260916_identity_photo_removal.sql','20260919_pipeline_stages.sql','20260914_client_commercial_lifecycle.sql'])await pg.exec(await fs.readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8'));
 const query=(sql,args)=>pg.query(sql,args),db={query,connect:async()=>({query,release(){}})};
 const {post,session}=new Function('db','budgetSections','crypto','visibleRecord','ensurePersonalIdentity','demoOrganization','currencies','roleCan','amount','validDate','fail','validItems','option','text','normalizedEmail','normalizedPhone','clientLogo','clientColor','assertUniqueClientRuc',`${helpers}
  return {session,post:async function(req,res){const url=new URL(req.url,'https://test.invalid');${routes}
   throw new Error('Unexpected route in isolated POST test');}};`)(db,budgetSections,crypto,visibleRecord,ensurePersonalIdentity,()=>{throw new Error('Demo setup is outside this test');},currencies,roleCan,amount,validDate,fail,validItems,option,text,normalizedEmail,normalizedPhone,clientLogo,clientColor,assertUniqueClientRuc);
 const userId=(await query("insert into users(email,password_hash) values('alta-validacion@example.invalid','unused') returning id")).rows[0].id;
 const otherUserId=(await query("insert into users(email,password_hash) values('alta-otro@example.invalid','unused') returning id")).rows[0].id;
 const org=(await query("insert into organizations(slug,name) values('alta-validacion','Alta validación') returning id")).rows[0].id;
 const otherOrg=(await query("insert into organizations(slug,name) values('alta-otra','Alta otra') returning id")).rows[0].id;
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",[org,userId,otherOrg,otherUserId]);
 const token='fixture-alta-validacion',otherToken='fixture-alta-otra';
 await query("insert into sessions(id,user_id,organization_id,expires_at) values($1,$2,$3,now()+interval '1 hour'),($4,$5,$6,now()+interval '1 hour')",[token,userId,org,otherToken,otherUserId,otherOrg]);
 function request(path,method,payload,current){const req=Readable.from([JSON.stringify(payload??{})]);req.method=method;req.url=path;req.headers={cookie:`scale_session=${current}`};req.socket={remoteAddress:'127.0.0.1'};return req;}
 async function alta(path,payload,current=token){
  let result={status:0};
  await post(request(path,'POST',payload,current),{writeHead(status){result.status=status;},end(value){Object.assign(result,JSON.parse(value));}});
  return result;
 }
 async function editar(path,payload,current=token){
  let result={status:0};
  const handled=await suite({req:request(path,'PATCH',payload,current),res:{},url:new URL(`https://test.invalid${path}`),db,session,body:async()=>payload,send:(_res,status,data)=>{result={status,...data};}});
  assert.equal(handled,true,`la edición cubre ${path}`);
  return result;
 }
 const clientPaths={name:'Cliente paridad',email:'paridad@example.invalid',phone:'+595 981123456',tax_id:'80012345-6',legal_name:'Razón social de prueba',notes:'Nota de alta'};
 const altaCliente=await alta('/api/agency/clients',clientPaths);
 assert.equal(altaCliente.status,201,JSON.stringify(altaCliente));
 const clienteId=altaCliente.client.id;
 assert.equal(altaCliente.client.tax_id,'80012345-6');
 assert.equal(altaCliente.client.legal_name,'Razón social de prueba');
 assert.equal((await editar(`/api/agency/clients/${clienteId}`,clientPaths)).status,200,'lo que el alta crea, la edición lo acepta');
 // La edición rechaza estos largos: el alta tiene que rechazarlos igual.
 for(const [field,value,label] of [
  ['name','x'.repeat(121),'nombre 121'],
  ['tax_id','8'.repeat(61),'RUC 61'],
  ['legal_name','L'.repeat(161),'razón social 161'],
  ['notes','N'.repeat(2001),'notas 2001'],
 ]){
  const payload={...clientPaths,[field]:value};
  assert.equal((await alta('/api/agency/clients',payload)).status,400,`el alta rechaza ${label}`);
  assert.equal((await editar(`/api/agency/clients/${clienteId}`,payload)).status,400,`la edición rechaza ${label}`);
 }
 assert.equal((await alta('/api/agency/clients',{...clientPaths,email:'sin-arroba'})).status,400,'el alta reusa el validador de correo');
 assert.equal((await alta('/api/agency/clients',{...clientPaths,phone:'++'})).status,400,'el alta reusa el validador de teléfono');
 const altaClienteLargo=await alta('/api/agency/clients',{...clientPaths,name:'Cliente de límites',tax_id:'80099999-1',legal_name:'L'.repeat(160),notes:'N'.repeat(2000)});
 assert.equal(altaClienteLargo.status,201,'los límites máximos de la edición también entran por el alta');
 assert.equal((await editar(`/api/agency/clients/${altaClienteLargo.client.id}`,{name:'Cliente de límites',tax_id:'80099999-1',legal_name:'L'.repeat(160),notes:'N'.repeat(2000)})).status,200,'el registro de límites queda editable');
 const budgetPaths={title:'Propuesta de paridad',clientId:clienteId,currency:'USD',validUntil:'2026-10-01',notes:'Condiciones',items:[{description:'Servicio mensual',quantity:2,unitPrice:10.555}]};
 const altaPresupuesto=await alta('/api/agency/budgets',budgetPaths);
 assert.equal(altaPresupuesto.status,201,JSON.stringify(altaPresupuesto));
 const presupuesto=altaPresupuesto.budget;
 assert.equal(presupuesto.valid_until.slice(0,10),'2026-10-01','la vigencia se guarda como fecha civil');
 assert.equal(presupuesto.subtotal,'21.12','el subtotal se redondea a dos decimales');
 assert.equal(presupuesto.total,'23.23','el total se redondea igual que en la edición');
 const itemRow=(await query('select description,quantity,unit_price::text as unit_price,total::text as total from agency_budget_items where budget_id=$1',[presupuesto.id])).rows[0];
 assert.deepEqual({...itemRow,quantity:itemRow.quantity},{description:'Servicio mensual',quantity:'2.00',unit_price:'10.56',total:'21.12'},'los ítems del alta guardan el mismo redondeo que la edición');
 assert.equal((await editar(`/api/agency/budgets/${presupuesto.id}`,budgetPaths)).status,200,'lo que el alta crea, la edición lo acepta');
 // La edición rechaza estos valores: el alta tiene que rechazarlos igual (400, no 500 por fecha inválida).
 for(const [payload,label] of [
  [{...budgetPaths,title:'T'.repeat(161)},'título 161'],
  [{...budgetPaths,title:'x'},'título de un carácter'],
  [{...budgetPaths,items:[]},'sin ítems'],
  [{...budgetPaths,items:Array.from({length:101},(_,index)=>({description:`Ítem ${index}`,quantity:1,unitPrice:1}))},'101 ítems'],
  [{...budgetPaths,items:[{description:'Servicio',quantity:0,unitPrice:1}]},'cantidad cero'],
  [{...budgetPaths,items:[{description:'Servicio',quantity:1000000,unitPrice:1}]},'cantidad fuera de tope'],
  [{...budgetPaths,items:[{description:'Servicio',quantity:1,unitPrice:-1}]},'precio negativo'],
  [{...budgetPaths,items:[{description:'Servicio',quantity:1,unitPrice:10000000000000}]},'precio fuera de tope'],
  [{...budgetPaths,items:[{description:'S'.repeat(501),quantity:1,unitPrice:1}]},'descripción 501'],
  [{...budgetPaths,validUntil:'2026-13-40'},'fecha inválida'],
  [{...budgetPaths,currency:'GBP'},'moneda inválida'],
  [{...budgetPaths,clientId:'abc'},'cliente inválido'],
 ]){
  assert.equal((await alta('/api/agency/budgets',payload)).status,400,`el alta rechaza ${label}`);
 }
 assert.equal((await alta('/api/agency/budgets',{...budgetPaths,clientId:999999})).status,404,'cliente inexistente');
 assert.equal((await alta('/api/agency/clients',{...clientPaths,tax_id:'80012345-6'})).status,409,'RUC duplicado en la empresa');
 assert.equal((await alta('/api/agency/budgets',{...budgetPaths},otherToken)).status,404,'el cliente de otra empresa no es direccionable');
 const after=(await query('select count(*)::int as count from agency_budgets')).rows[0].count;
 assert.equal(after,1,'los rechazos no dejan presupuestos creados');
 console.log('PASS: el alta de clientes y presupuestos comparte validación, límites y redondeo con la edición; 21 rechazos (18 con 400, dos 404 y un 409), fechas civiles y montos a dos decimales. PGlite only; no server/init/network started.');
}finally{await pg.close();}
