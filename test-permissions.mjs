// Permisos por empresa: matriz, overrides y orden del reparto frente a la suscripción.
// PGlite en memoria; no toca producción.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {rolePermissions,CAPABILITIES,roleCan} from './permissions.js';
import {migrationOrder} from './scripts/migration-order.mjs';

const pg=new PGlite();
await pg.exec(await fs.readFile('schema.sql','utf8'));
// Cadena real hasta la auditoría de permisos (#23): el trigger compartido de
// agency_operation_audit vive en operations_complete y depende de migraciones
// anteriores, así que se aplica el prefijo curado.
for(const file of migrationOrder){
 await pg.exec(await fs.readFile(`migrations/${file}`,'utf8'));
 if(file==='20260921_role_permissions_audit.sql')break;
}
const query=(sql,args)=>pg.query(sql,args),db={query,connect:async()=>({query,release(){}})};
const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
const other=(await query("insert into organizations(slug,name) values('perm-other','Otra') returning id")).rows[0].id;
const uid=(await query("insert into users(email,password_hash) values('perm-owner@example.invalid','unused') returning id")).rows[0].id;
const peers=(await query(`insert into users(email,password_hash) values
 ('perm-admin@example.invalid','unused'),('perm-finance@example.invalid','unused'),('perm-viewer@example.invalid','unused') returning id`)).rows.map(row=>row.id);
const members=(await query(`insert into organization_members(organization_id,user_id,role)
 values($1,$2,'owner'),($1,$3,'admin'),($1,$4,'finance'),($1,$5,'viewer') returning user_id,role`,[org,uid,peers[0],peers[1],peers[2]])).rows;
const owner={id:uid,organization_id:org,role:'owner',organization_name:'Scale'};
const admin={...owner,role:'admin'};
const finance={...owner,role:'finance'};
const viewer={...owner,role:'viewer'};
assert.equal(members.length,4);

let result;
async function call(method='GET',payload,as=owner){
 result={status:0};
 const handled=await rolePermissions({req:{method,socket:{remoteAddress:'127.0.0.1'}},res:{},url:new URL('https://test/api/agency/permissions'),db,session:async()=>as,body:async()=>payload,send:(_,status,data)=>{result={status,...data};}});
 assert.equal(handled,true);return result;
}

// Lectura: solo Dueño y Administración.
assert.equal((await call('GET',undefined,owner)).status,200);
assert.equal((await call('GET',undefined,admin)).status,200);
assert.equal((await call('GET',undefined,finance)).status,403,'Finanzas no administra la matriz');
assert.equal((await call('GET',undefined,viewer)).status,403);
assert.equal((await call('GET',undefined,null)).status,401,'sin sesión es 401, no 403');
const matrix=await call('GET');
assert.deepEqual(matrix.roles,['admin','management','finance','sales','production','editor','viewer','collaborator'],'el Dueño no se lista como rol editable');
assert.equal(matrix.capabilities.length,CAPABILITIES.length);
assert.equal(matrix.capabilities.find(row=>row.id==='members.manage').defaults.includes('management'),true);

// Escritura: solo el Dueño; nunca sobre el rol Dueño.
assert.equal((await call('PATCH',{capability:'members.manage',role:'management',allowed:false},admin)).status,403,'un administrador no personaliza permisos');
assert.equal((await call('PATCH',{capability:'members.manage',role:'owner',allowed:false},owner)).status,400,'el Dueño conserva todas las capacidades');
assert.equal((await call('PATCH',{capability:'inexistente',role:'sales',allowed:true})).status,400);
assert.equal((await call('PATCH',{capability:'members.manage',role:'socio',allowed:true})).status,400);
assert.equal((await call('PATCH',{capability:'members.manage',role:'sales',allowed:'sí'})).status,400);
assert.equal((await call('PATCH',{campo:'x'})).status,400,'campos no permitidos');

// Un PATCH con rol y valor pero sin capacidad debe ser 400 (antes rompía la columna not null → 500).
assert.equal((await call('PATCH',{role:'sales',allowed:true})).status,400,'falta la capacidad');

// Override efectivo: se refleja en la matriz y en roleCan.
let patched=await call('PATCH',{capability:'members.manage',role:'management',allowed:false});
assert.equal(patched.status,200);
assert.equal(patched.capabilities.find(row=>row.id==='members.manage').overrides.management,false);
assert.equal(roleCan({role:'management',capabilities:{'members.manage':false}},'members.manage'),false);
assert.equal(roleCan({role:'management'},'members.manage'),true,'sin override rige el valor por defecto');

// La UI promete que los cambios se auditan: el API registra actor y antes/después.
const audited=(await query("select actor,ip,action,table_name,after_state,before_state from agency_operation_audit where table_name='agency_role_permissions' order by id desc limit 1")).rows[0];
assert(audited,'un PATCH deja su fila de auditoría');
assert.equal(audited.actor,String(uid),'la auditoría guarda el usuario que cambió el permiso');
assert.equal(audited.ip,'127.0.0.1');
assert.equal(audited.action,'INSERT','el primer override se audita como alta');
assert.equal(audited.after_state.capability,'members.manage');
assert.equal(audited.after_state.role,'management');
assert.equal(audited.after_state.allowed,false);
assert.equal(audited.before_state,null,'sin valor previo no se inventa un antes');
await call('PATCH',{capability:'members.manage',role:'management',allowed:true});
const updated=(await query("select action,before_state,after_state from agency_operation_audit where table_name='agency_role_permissions' order by id desc limit 1")).rows[0];
assert.equal(updated.action,'UPDATE','un override existente se audita como edición');
assert.equal(updated.before_state.allowed,false);
assert.equal(updated.after_state.allowed,true);
await call('PATCH',{capability:'members.manage',role:null,allowed:null});
const removed=(await query("select action,before_state,after_state from agency_operation_audit where table_name='agency_role_permissions' order by id desc limit 2")).rows;
assert.equal(removed[0].action,'DELETE','restablecer la capacidad se audita como baja');
assert.equal(removed[0].before_state.capability,'members.manage');
assert.equal(removed[0].after_state,null);

// Restablecer una fila y todo.
assert.equal((await call('PATCH',{capability:'members.manage',role:null,allowed:null})).status,200);
assert.equal((await query('select count(*)::int as total from agency_role_permissions where organization_id=$1',[org])).rows[0].total,0,'restablecer la capacidad borra sus overrides');
await call('PATCH',{capability:'members.manage',role:'management',allowed:false});
await call('PATCH',{capability:'settings.manage',role:'admin',allowed:false});
assert.equal((await call('PATCH',{capability:null,role:null,allowed:null})).status,200);
assert.equal((await query('select count(*)::int as total from agency_role_permissions where organization_id=$1',[org])).rows[0].total,0,'restablecer todo limpia la empresa');

// Aislamiento por empresa.
await call('PATCH',{capability:'members.manage',role:'management',allowed:false});
const isolated=await call('GET',undefined,{...owner,organization_id:other});
assert.equal(isolated.status,200);
assert.equal(isolated.capabilities.find(row=>row.id==='members.manage').overrides.management,undefined,'los overrides no cruzan de empresa');

// El Dueño siempre puede: roleCan no consulta overrides para owner.
assert.equal(roleCan({role:'owner',capabilities:{'members.manage':false}},'members.manage'),true);
assert.equal(roleCan(null,'members.manage'),false);

// Orden del reparto: la matriz va después del corte por suscripción (lectura privada).
const server=await fs.readFile('server.js','utf8');
const gate=server.indexOf('SUBSCRIPTION_REQUIRED');
const permissionsDispatch=server.indexOf('await rolePermissions({req,res,url,db,session,body,send})');
assert.ok(gate>0&&permissionsDispatch>gate,'/api/agency/permissions debe resolverse después del gate de suscripción');

console.log('PASS: matriz de permisos por empresa, overrides verificados, roles protegidos, aislamiento por empresa, 401/403 correctos, reset por fila y total, y orden frente a la suscripción.');
