import {fail,id} from './suite-validation.js';

export function mentionIds(value){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>20)fail('Menciones inválidas');
 return [...new Set(value.map(id))];
}
const escaped=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const hasMention=(body,name)=>new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped(name)}(?=$|[^\\p{L}\\p{N}_])`,'iu').test(body);

// Match only active members in this organization.  The stored ID is the stable
// recipient; the visible @name is never trusted as an identity by itself.
export async function parsedMentionIds(c,organizationId,body){
 if(typeof body!=='string')fail('Comentario inválido');
 const rows=(await c.query(`select m.user_id::text as user_id,coalesce(nullif(trim(i.full_name),''),i.email) as mention_name
   from organization_members m join organizations o on o.id=m.organization_id
   join organization_person_identity i on i.organization_id=m.organization_id and i.user_id=m.user_id
   where m.organization_id=$1 and m.active and m.removed_at is null and o.active`,[organizationId])).rows;
 return [...new Set(rows.filter(row=>row.mention_name&&hasMention(body,row.mention_name)).map(row=>row.user_id))];
}
export async function saveCommentMentions(c,{organizationId,commentKind,commentId,mentionedUserIds,workOrderId=null,projectId=null,title,body}){
 const parsed=await parsedMentionIds(c,organizationId,body);
 const requested=mentionIds(mentionedUserIds);
 if(requested.length&&(requested.length!==parsed.length||requested.some(value=>!parsed.includes(value))))fail('Las menciones deben coincidir con los nombres @mencionados en el comentario');
 if(!parsed.length)return [];
 const table=commentKind==='project'?'agency_project_comment_mentions':'agency_order_comment_mentions';
 const column=commentKind==='project'?'project_comment_id':'order_comment_id';
 await c.query(`insert into ${table}(organization_id,${column},mentioned_user_id)
   select $1,$2,member_id from unnest($3::bigint[]) as member_id
   on conflict do nothing`,[organizationId,commentId,parsed]);
  const dedupe=(commentKind==='project'?'agency_project_comments:':'agency_order_comments:')+commentId;
  const commentKey=commentKind==='order'?commentId:null;
  for(const recipient of parsed){
   await c.query("select enqueue_agency_notification($1,$2,'comment',$3,$4,$5,$6,$7,$8)",[organizationId,recipient,title,body,workOrderId,projectId,dedupe,commentKey]);
  }
 return parsed;
}
