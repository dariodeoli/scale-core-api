import {fail,id} from './suite-validation.js';

// IDs are sent separately from the visible comment text.  Never infer a
// recipient from a display name: names can change and are not unique.
export function mentionIds(value){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>20)fail('Menciones inválidas');
 const ids=[...new Set(value.map(id))];
 return ids;
}

export async function saveCommentMentions(c,{organizationId,commentKind,commentId,mentionedUserIds,workOrderId=null,projectId=null,title,body}){
 const users=mentionIds(mentionedUserIds);
 if(!users.length)return [];
 const ids=users.map(id);
 const active=(await c.query(`select m.user_id from organization_members m
   join organizations o on o.id=m.organization_id
   where m.organization_id=$1 and m.user_id=any($2::bigint[])
    and m.active and m.removed_at is null and o.active
   order by m.user_id`,[organizationId,ids])).rows.map(row=>String(row.user_id));
 if(active.length!==ids.length)fail('Solo podés mencionar integrantes activos de esta empresa');
 const table=commentKind==='project'?'agency_project_comment_mentions':'agency_order_comment_mentions';
 const column=commentKind==='project'?'project_comment_id':'order_comment_id';
 await c.query(`insert into ${table}(organization_id,${column},mentioned_user_id)
   select $1,$2,member_id from unnest($3::bigint[]) as member_id
   on conflict do nothing`,[organizationId,commentId,ids]);
 const dedupe=(commentKind==='project'?'agency_project_comments:':'agency_order_comments:')+commentId;
 for(const recipient of active){
  await c.query("select enqueue_agency_notification($1,$2,'comment',$3,$4,$5,$6,$7)",[organizationId,recipient,title,body,workOrderId,projectId,dedupe]);
 }
 return active;
}
