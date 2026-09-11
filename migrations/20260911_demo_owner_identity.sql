-- A signed-in real owner sees their current personal identity in their private demo.
-- Keep is_demo true: a demo must never acquire permission to write real identity.
-- Anonymous visitors and fictional staff remain isolated. No profile rows are rewritten.
create or replace view organization_person_identity as
 select m.organization_id,m.user_id,u.email,
  case when g.user_id is not null then g.full_name else coalesce(p.full_name,'') end as full_name,
  case when g.user_id is not null then g.photo_url else p.photo_url end as photo_url,
  (o.demo_owner_user_id is not null or o.demo_source_id is not null
   or o.slug='scale-demo-controles-20260908' or u.is_demo_guest) as is_demo,
  (g.user_id is not null and o.demo_owner_user_id=m.user_id) as personal_in_demo
 from organization_members m join organizations o on o.id=m.organization_id
 join users u on u.id=m.user_id
 left join agency_user_profiles p on p.organization_id=m.organization_id and p.user_id=m.user_id
 left join user_personal_identities g on g.user_id=m.user_id and not u.is_demo_guest
  and ((o.demo_owner_user_id is null and o.demo_source_id is null and o.slug<>'scale-demo-controles-20260908')
   or (o.demo_owner_user_id=m.user_id and o.demo_expires_at>now() and exists(
    select 1 from organization_members rm join organizations ro on ro.id=rm.organization_id
    where rm.user_id=m.user_id and rm.active and rm.removed_at is null and ro.active
     and ro.demo_owner_user_id is null and ro.demo_source_id is null and ro.slug<>'scale-demo-controles-20260908')))
 where m.active and m.removed_at is null and o.active;
