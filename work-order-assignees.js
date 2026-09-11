import {visibleRecord} from './record-lifecycle.js';

// One batched lookup for a complete response. Inheritance is display context,
// never a stored assignment, permission grant, or name/alias-based identity match.
export async function enrichWorkOrderAssignees(c,org,records){
 const list=(Array.isArray(records)?records:[records]).filter(Boolean);
 if(!list.length)return;
 const ids=[...new Set(list.map(row=>String(row.id)))];
 const rows=(await c.query(`with orders as (
  select o.id,o.project_id from agency_work_orders o
  join agency_projects p on p.id=o.project_id and p.organization_id=o.organization_id
  join agency_clients cl on cl.id=p.client_id and cl.organization_id=p.organization_id
  where o.organization_id=$1 and o.id=any($2::bigint[])
   and ${visibleRecord('o','work-orders')} and ${visibleRecord('p','projects')} and ${visibleRecord('cl','clients')}
 ), assignments as (
  select o.id as work_order_id,a.user_id,a.is_primary,'direct'::text as source
  from orders o join agency_record_assignees a on a.organization_id=$1 and a.kind='work-orders' and a.record_id=o.id
  union all
  select o.id,a.user_id,a.is_primary,'project'::text
  from orders o join agency_record_assignees a on a.organization_id=$1 and a.kind='projects' and a.record_id=o.project_id
 ) select a.work_order_id::text,a.user_id::text as id,a.is_primary,a.source,
  coalesce(nullif(trim(i.full_name),''),i.email) as full_name,i.photo_url
 from assignments a join organization_person_identity i on i.organization_id=$1 and i.user_id=a.user_id
 order by a.work_order_id,a.source,a.is_primary desc,a.user_id`,[org,ids])).rows;
 const byOrder=new Map();
 for(const {work_order_id,...person} of rows){
  if(!byOrder.has(work_order_id))byOrder.set(work_order_id,{direct:[],project:[]});
  byOrder.get(work_order_id)[person.source].push(person);
 }
 for(const record of list){
  const assigned=byOrder.get(String(record.id))||{direct:[],project:[]};
  record.assignees=assigned.direct;
  record.project_assignees=assigned.project;
  record.effective_assignees=assigned.direct.length?assigned.direct:assigned.project;
  record.assignee_source=assigned.direct.length?'direct':assigned.project.length?'project':null;
 }
}
