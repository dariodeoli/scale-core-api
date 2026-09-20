// Permisos por empresa: matriz, overrides y orden del reparto frente a la suscripción.
// PGlite en memoria; no toca producción.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {rolePermissions,CAPABILITIES,roleCan} from './permissions.js';

const pg=new PGlite();
await pg.exec(await fs.readFile('schema.sql','utf8'));
await pg.exec(await fs.readFile('migrations/20260914_role_permissions.sql','utf8'));
const query=(sql,args)=>pg.query(sql,args),db={query};
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
