import {fail, owned, text} from './suite-validation.js';

const readers = ['owner','admin','management','finance','sales','production','editor','viewer'];
const writers = ['owner','admin','management','production','editor'];
const maxItems = 100;
function identifier(value, zero = false) {
 if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('Identificador inválido');
 if (!['number','string'].includes(typeof value) || !/^\d{1,19}$/.test(String(value))) fail('Identificador inválido');
 const n = BigInt(value);
 if (n < (zero ? 0n : 1n) || n > 9223372036854775807n) fail('Identificador inválido');
 return String(n);
}
async function snapshot(c, org, order) {
 const state = (await c.query('select version::text from agency_work_checklists where organization_id=$1 and work_order_id=$2', [org, order])).rows[0];
 const items = (await c.query('select id::text,text,completed from agency_work_checklist_items where organization_id=$1 and work_order_id=$2 order by id', [org, order])).rows;
 return {version: state?.version || '0', items, total: items.length, completed: items.filter(i => i.completed).length, max_items: maxItems};
}
export async function workChecklists({req, res, url, db, session, body, send}) {
 const match = url.pathname.match(/^\/api\/agency\/work-orders\/(\d+)\/checklist(?:\/(items)(?:\/(\d+))?)?$/);
 if (!match) return false;
 let c, tx = false;
 try {
  const user = await session(req); if (!user) fail('No autenticado', 401);
  const [, rawOrder, itemsPath, rawItem] = match;
  const read = req.method === 'GET' && !itemsPath;
  const add = req.method === 'POST' && itemsPath && !rawItem;
  const edit = req.method === 'PATCH' && rawItem;
  const remove = req.method === 'DELETE' && rawItem;
  if (!read && !add && !edit && !remove) fail('Método no permitido', 405);
  const allowed = read ? readers : writers;
  if (!allowed.includes(user.role)) fail('Tu rol no permite modificar el checklist', 403);
  const org = identifier(user.organization_id), order = identifier(rawOrder), person = identifier(user.id);
  c = await db.connect(); await c.query('begin'); tx = true;
  const member = (await c.query(`select m.role from organization_members m join organizations o on o.id=m.organization_id
   where m.organization_id=$1 and m.user_id=$2 and m.active and m.removed_at is null and o.active for share of m,o`, [org, person])).rows[0];
  if (!member || !allowed.includes(member.role)) fail('Sin acceso activo para esta operación', 403);
  // Serialize writers even before the first checklist row exists. Validate all
  // ancestors so an archived or inconsistent legacy parent cannot bypass scope.
  const piece = await owned(c, 'agency_work_orders', order, org);
  const project = await owned(c, 'agency_projects', piece.project_id, org);
  await owned(c, 'agency_clients', project.client_id, org);
  let status = 200;
  if (!read) {
   const payload = await body(req);
   const fields = add ? ['expected_version','text'] : edit ? ['expected_version','text','completed'] : ['expected_version'];
   if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(k => !fields.includes(k))) fail('Checklist inválido');
   const expected = identifier(payload.expected_version, true);
   const current = await snapshot(c, org, order);
   if (expected !== current.version) fail('El checklist cambió. Recargá para revisar los cambios antes de guardar.', 409);
   let item;
   if (rawItem) {
    const key = identifier(rawItem);
    item = current.items.find(i => i.id === key);
    if (!item) fail('Ítem no encontrado', 404);
   }
   let value;
   if (add || Object.hasOwn(payload, 'text')) {
    value = text(payload.text, 500); if (!value) fail('Escribí un ítem de hasta 500 caracteres');
   }
   if (Object.hasOwn(payload, 'completed') && typeof payload.completed !== 'boolean') fail('Estado de ítem inválido');
   if (edit && !Object.hasOwn(payload, 'text') && !Object.hasOwn(payload, 'completed')) fail('Elegí qué cambiar');
   if (add && current.items.length >= maxItems) fail('Máximo 100 ítems por pieza');
   const changed = !edit || value !== undefined && value !== item.text || Object.hasOwn(payload, 'completed') && payload.completed !== item.completed;
   if (changed) {
    await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true),set_config('app.current_organization',$3,true)", [person, req.socket?.remoteAddress || '', org]);
    await c.query('insert into agency_work_checklists(organization_id,work_order_id) values($1,$2) on conflict do nothing', [org, order]);
    const bumped = await c.query('update agency_work_checklists set version=version+1 where organization_id=$1 and work_order_id=$2 and version=$3 returning version', [org, order, expected]);
    if (!bumped.rows.length) fail('El checklist cambió. Recargá antes de guardar.', 409);
    if (add) {
     await c.query('insert into agency_work_checklist_items(organization_id,work_order_id,text,created_by_user_id) values($1,$2,$3,$4)', [org, order, value, person]); status = 201;
    } else if (edit) {
     await c.query('update agency_work_checklist_items set text=$1,completed=$2,updated_at=now() where id=$3 and organization_id=$4 and work_order_id=$5', [value ?? item.text, payload.completed ?? item.completed, item.id, org, order]);
    } else await c.query('delete from agency_work_checklist_items where id=$1 and organization_id=$2 and work_order_id=$3', [item.id, org, order]);
   }
  }
  const result = await snapshot(c, org, order);
  await c.query('commit'); tx = false;
  send(res, status, result, {'Cache-Control':'no-store'});
 } catch (error) {
  if (tx) await c.query('rollback');
  console.error(JSON.stringify({event:'work_checklist_error',status:error.status || 500}));
  send(res, error.status || 500, {error:error.status ? error.message : 'No se pudo actualizar el checklist'}, {'Cache-Control':'no-store'});
 } finally { c?.release(); }
 return true;
}
