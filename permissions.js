const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export const roles=['owner','admin','management','finance','sales','production','editor','viewer','collaborator'];
export const roleLabels={owner:'Dueño',admin:'Administrador',management:'Gerencia',finance:'Finanzas',sales:'Ventas',production:'Producción',editor:'Editor',viewer:'Solo lectura',collaborator:'Colaborador'};
const all=[...roles];
// Los roles del checklist viven en un solo lugar: ver y editar comparten audiencia.
const checklistRoles=['owner','admin','management','production','editor','collaborator'];
export const CAPABILITIES=[
 {id:'members.manage',label:'Equipo y accesos',description:'Personas, cargos, accesos, invitaciones y remuneraciones.',roles:['owner','admin','management']},
 {id:'settings.manage',label:'Configuración de la empresa',description:'Datos de la empresa, moneda y cotización.',roles:['owner','admin']},
 {id:'activity.view',label:'Actividad del equipo',description:'Ver actividad y auditoría de la empresa.',roles:['owner','admin']},
 {id:'metrics.view',label:'Métricas y crecimiento',description:'Métricas del sitio y panel de crecimiento.',roles:['owner','admin']},
 {id:'visitors.view',label:'Visitantes en vivo',description:'Visitas activas del landing y uso.',roles:['owner','admin']},
 {id:'company.create',label:'Crear empresas',description:'Crear empresas adicionales.',roles:['owner','admin']},
 {id:'clients.manage',label:'Gestionar clientes',description:'Crear y editar clientes, enlaces y ficha comercial.',roles:['owner','admin','management','sales','finance','collaborator']},
 {id:'projects.manage',label:'Crear proyectos',description:'Crear proyectos de trabajo.',roles:['owner','admin','management','sales','production','collaborator']},
 {id:'projects.edit',label:'Editar proyectos',description:'Editar datos y responsables de proyectos.',roles:['owner','admin','management','production','collaborator']},
 {id:'work-orders.manage',label:'Gestionar piezas',description:'Crear piezas y acciones de producción.',roles:['owner','admin','management','production','collaborator']},
 {id:'work-orders.edit',label:'Editar y mover piezas',description:'Editar piezas y cambiar su estado.',roles:['owner','admin','management','production','editor','collaborator']},
 {id:'assignees.manage',label:'Responsables',description:'Asignar responsables a proyectos y piezas.',roles:['owner','admin','management','production','collaborator']},
 {id:'work-checklists.view',label:'Ver checklists',description:'Leer los checklists de las piezas.',roles:checklistRoles},
 {id:'checklists.edit',label:'Checklists',description:'Editar checklists de piezas.',roles:checklistRoles},
 {id:'commercial.manage',label:'Pipeline comercial',description:'Oportunidades y seguimiento comercial.',roles:['owner','admin','management','finance','sales','collaborator']},
 {id:'budgets.manage',label:'Presupuestos y planes',description:'Presupuestos, planes reutilizables y cotización.',roles:['owner','admin','management','finance','sales','production','collaborator']},
 {id:'commercial-terms.manage',label:'Términos comerciales',description:'Plan contratado, monto, comisión y factura por cliente.',roles:['owner','admin','management','sales']},
 {id:'billing.view',label:'Cobranza y facturas',description:'Ver mora, facturas y cobros.',roles:['owner','admin','management','finance','sales']},
 {id:'finance.view',label:'Saldos y previsión',description:'Saldos, dashboard financiero y previsión mensual.',roles:['owner','admin','finance']},
 {id:'accounts.manage',label:'Cuentas y custodios',description:'Cuentas bancarias y custodios.',roles:['owner','admin','finance']},
 {id:'invoices.manage',label:'Facturas',description:'Crear y editar facturas.',roles:['owner','admin','management','finance','sales']},
 {id:'payments.manage',label:'Cobros y pagos',description:'Registrar cobros y pagos.',roles:['owner','admin','finance']},
 {id:'transfers.manage',label:'Transferencias',description:'Registrar transferencias entre cuentas.',roles:['owner','admin','finance']},
 {id:'commissions.manage',label:'Comisiones y referidos',description:'Comisiones, referidos y descuentos.',roles:['owner','admin','finance']},
 {id:'reports.view',label:'Informes',description:'Informes mensuales y evolución.',roles:['owner','admin','finance','sales']},
 {id:'expenses.manage',label:'Gastos planificados',description:'Gastos fijos y variables mensuales.',roles:['owner','admin','finance']},
 {id:'inventory.view',label:'Ver inventario',description:'Equipos, categorías y reservas.',roles:all},
 {id:'inventory.manage',label:'Gestionar inventario',description:'Equipos, categorías y ubicaciones.',roles:['owner','admin','management','production','finance','collaborator']},
 {id:'inventory.book',label:'Reservar equipos',description:'Crear y editar reservas de equipos.',roles:['owner','admin','management','production','collaborator']},
 {id:'studio.manage',label:'Estudio',description:'Espacios y reservas del estudio.',roles:['owner','admin','management','sales','production','collaborator']},
 {id:'portal-access.manage',label:'Accesos del portal',description:'Invitar y revocar clientes del portal.',roles:['owner','admin','management','production']},
 {id:'portal.manage',label:'Portal del cliente',description:'Publicar entregas y gestionar revisiones.',roles:['owner','admin','management','production','collaborator']},
 {id:'salary.view',label:'Ver salarios',description:'Salarios y ajustes mensuales del equipo.',roles:['owner','admin','finance']},
];
const byId=new Map(CAPABILITIES.map(capability=>[capability.id,capability]));
/** The owner always keeps every capability; overrides apply to the other roles. */
export function roleCan(user,capability){
 if(!user)return false;
 if(user.role==='owner')return true;
 const definition=byId.get(capability);if(!definition)return false;
 const override=user.capabilities?.[capability];
 return override===undefined?definition.roles.includes(user.role):Boolean(override);
}
export function permissionMatrix(overrides){
 const rows=(overrides||[]).reduce((map,row)=>{map[`${row.role}:${row.capability}`]=row.allowed;return map;},{});
 return CAPABILITIES.map(capability=>({id:capability.id,label:capability.label,description:capability.description,defaults:capability.roles,overrides:Object.fromEntries(roles.filter(role=>role!=='owner').map(role=>[role,rows[`${role}:${capability.id}`]]))}));
}
export async function rolePermissions({req,res,url,db,session,body,send}){
 if(!url.pathname.startsWith('/api/agency/permissions'))return false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  if(!['owner','admin'].includes(user.role))fail('Tu rol no permite ver los permisos',403);
  if(req.method==='GET'){
   const rows=(await db.query('select role,capability,allowed,updated_at from agency_role_permissions where organization_id=$1 order by role,capability',[user.organization_id])).rows;
   send(res,200,{roles:roles.filter(role=>role!=='owner'),capabilities:permissionMatrix(rows)});return true;
  }
  if(req.method==='PATCH'){
   if(user.role!=='owner')fail('Solo un dueño puede personalizar permisos',403);
   const input=await body(req);
   const keys=Object.keys(input||{});
   if(!input||keys.some(key=>!['capability','role','allowed'].includes(key))||!Object.hasOwn(input,'allowed'))fail('Campos de permiso inválidos');
   const capability=input.capability??null,role=input.role??null,allowed=input.allowed;
   if(capability!==null&&(typeof capability!=='string'||!byId.has(capability)))fail('Capacidad inválida');
   if(role!==null&&(typeof role!=='string'||!roles.includes(role)||role==='owner'))fail('Rol inválido');
   if(allowed!==null&&typeof allowed!=='boolean')fail('Valor de permiso inválido');
   // La UI promete auditar los cambios de permisos: el trigger compartido de
   // agency_operation_audit los registra con actor, IP y antes/después. La
   // transacción fija app.current_user/ip para que el actor sea real.
   const client=typeof db.connect==='function'?await db.connect():null;
   const runner=client||db;
   try{
    if(client){
     await client.query('begin');
     await client.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket?.remoteAddress||'']);
    }
    if(allowed===null){
     if(capability===null)await runner.query('delete from agency_role_permissions where organization_id=$1',[user.organization_id]);
     else if(role===null)await runner.query('delete from agency_role_permissions where organization_id=$1 and capability=$2',[user.organization_id,capability]);
     else await runner.query('delete from agency_role_permissions where organization_id=$1 and role=$2 and capability=$3',[user.organization_id,role,capability]);
    }else{
     if(capability===null)fail('Indicá la capacidad para aplicar un permiso');
     if(role===null)fail('Indicá el rol para aplicar un permiso');
     await runner.query(`insert into agency_role_permissions(organization_id,role,capability,allowed,updated_by_user_id) values($1,$2,$3,$4,$5) on conflict(organization_id,role,capability) do update set allowed=excluded.allowed,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()`,[user.organization_id,role,capability,allowed,user.id]);
    }
    if(client)await client.query('commit');
   }catch(error){if(client)await client.query('rollback');throw error;}finally{client?.release();}
   const rows=(await db.query('select role,capability,allowed,updated_at from agency_role_permissions where organization_id=$1 order by role,capability',[user.organization_id])).rows;
   send(res,200,{roles:roles.filter(role=>role!=='owner'),capabilities:permissionMatrix(rows)});return true;
  }
  fail('Método no permitido',405);
 }catch(error){send(res,error.status||500,{error:error.status?error.message:'No se pudo completar la operación de permisos.'});return true;}
}
