-- Run after productivity, profile_identity, demo_sessions and invite_links.
-- The caller owns the transaction. Only an explicit users.id joins identities.
create table if not exists user_personal_identities (
 user_id bigint primary key references users(id) on delete cascade,
 full_name text not null check(length(trim(full_name)) between 2 and 120),
 photo_url text, updated_at timestamptz not null default now()
);

-- A demo is identified by its explicit metadata or the known shared template,
-- never by a person's email, name or a fuzzy organization-name match.
create or replace view organization_person_identity as
 select m.organization_id,m.user_id,u.email,
  case when g.user_id is not null then g.full_name else coalesce(p.full_name,'') end as full_name,
  case when g.user_id is not null then g.photo_url else p.photo_url end as photo_url,
  (o.demo_owner_user_id is not null or o.demo_source_id is not null
   or o.slug='scale-demo-controles-20260908' or u.is_demo_guest) as is_demo,
  false as personal_in_demo
 from organization_members m join organizations o on o.id=m.organization_id
 join users u on u.id=m.user_id
 left join agency_user_profiles p on p.organization_id=m.organization_id and p.user_id=m.user_id
 left join user_personal_identities g on g.user_id=m.user_id and not u.is_demo_guest
  and o.demo_owner_user_id is null and o.demo_source_id is null and o.slug<>'scale-demo-controles-20260908'
 where m.active and m.removed_at is null and o.active;

-- Bootstrap once from the latest eligible real profile; ties use organization id.
-- A null photo on the winning profile is intentional, not a reason to revive an old photo.
drop trigger if exists personal_identity_authorize on user_personal_identities;
insert into user_personal_identities(user_id,full_name,photo_url,updated_at)
 select distinct on(p.user_id) p.user_id,trim(p.full_name),p.photo_url,p.updated_at
 from agency_user_profiles p
 join organization_person_identity i on i.organization_id=p.organization_id and i.user_id=p.user_id
 where not i.is_demo and length(trim(p.full_name)) between 2 and 120
 order by p.user_id,p.updated_at desc,p.organization_id asc
 on conflict(user_id) do nothing;

-- Local HR/profile writes may never change the canonical identity. Apply its
-- display fields only when the linked user is a current member of this company.
create or replace function preserve_personal_identity() returns trigger language plpgsql as $$
declare identity record;
begin
 select g.full_name,g.photo_url into identity from user_personal_identities g
 join organization_person_identity i on i.user_id=g.user_id and i.organization_id=new.organization_id
 where g.user_id=new.user_id and not i.is_demo;
 if found then new.full_name=identity.full_name;new.photo_url=identity.photo_url;end if;
 return new;
end $$;
drop trigger if exists personal_identity_preserve on agency_user_profiles;
create trigger personal_identity_preserve before insert or update of user_id,organization_id,full_name,photo_url
 on agency_user_profiles for each row execute function preserve_personal_identity();
drop trigger if exists personal_identity_preserve on agency_collaborators;
create trigger personal_identity_preserve before insert or update of user_id,organization_id,full_name,photo_url
 on agency_collaborators for each row execute function preserve_personal_identity();

create or replace function authorize_personal_identity() returns trigger language plpgsql as $$
begin
 if new.user_id::text is distinct from nullif(current_setting('app.current_user',true),'')
  or (tg_op='UPDATE' and new.user_id is distinct from old.user_id)
  or not exists(select 1 from organization_person_identity i where i.user_id=new.user_id
   and i.organization_id::text=current_setting('app.current_organization',true) and not i.is_demo)
 then raise exception 'Personal identity requires its owner in a real organization' using errcode='42501';end if;
 return new;
end $$;
create trigger personal_identity_authorize before insert or update on user_personal_identities
 for each row execute function authorize_personal_identity();

create or replace function distribute_personal_identity() returns trigger language plpgsql as $$
begin
 insert into agency_user_profiles(user_id,organization_id,full_name,photo_url)
  select new.user_id,i.organization_id,new.full_name,new.photo_url
  from organization_person_identity i where i.user_id=new.user_id and not i.is_demo
  order by i.organization_id
  on conflict(user_id,organization_id) do update set full_name=excluded.full_name,photo_url=excluded.photo_url,updated_at=now()
  where (agency_user_profiles.full_name,agency_user_profiles.photo_url) is distinct from (excluded.full_name,excluded.photo_url);
 -- The existing local sync skips nested triggers, so reconcile linked HR copies explicitly.
 update agency_collaborators c set full_name=new.full_name,photo_url=new.photo_url,updated_at=now()
  from organization_person_identity i where i.organization_id=c.organization_id and i.user_id=c.user_id
  and c.user_id=new.user_id and not i.is_demo
  and (c.full_name,c.photo_url) is distinct from (new.full_name,new.photo_url);
 return new;
end $$;
drop trigger if exists personal_identity_distribute on user_personal_identities;
create trigger personal_identity_distribute after insert or update of full_name,photo_url on user_personal_identities
 for each row execute function distribute_personal_identity();

-- Initial reconciliation does not write salaries, job roles, email or access.
insert into agency_user_profiles(user_id,organization_id,full_name,photo_url)
 select g.user_id,i.organization_id,g.full_name,g.photo_url from user_personal_identities g
 join organization_person_identity i on i.user_id=g.user_id and not i.is_demo
 on conflict(user_id,organization_id) do update set full_name=excluded.full_name,photo_url=excluded.photo_url,updated_at=now()
 where (agency_user_profiles.full_name,agency_user_profiles.photo_url) is distinct from (excluded.full_name,excluded.photo_url);
update agency_collaborators c set full_name=g.full_name,photo_url=g.photo_url,updated_at=now()
 from user_personal_identities g,organization_person_identity i
 where g.user_id=c.user_id and i.user_id=c.user_id and i.organization_id=c.organization_id and not i.is_demo
 and (c.full_name,c.photo_url) is distinct from (g.full_name,g.photo_url);

-- New real memberships inherit display identity. Private demos get a one-time
-- copy for their owner only; subsequent demo edits remain local forever.
create or replace function seed_membership_personal_identity() returns trigger language plpgsql as $$
declare identity record;
begin
 if not new.active or new.removed_at is not null then return new;end if;
 select g.full_name,g.photo_url into identity
 from user_personal_identities g join organization_person_identity i on i.user_id=g.user_id
 where g.user_id=new.user_id and i.organization_id=new.organization_id and not i.is_demo;
 if found then
  insert into agency_user_profiles(user_id,organization_id,full_name,photo_url)
  values(new.user_id,new.organization_id,identity.full_name,identity.photo_url)
  on conflict(user_id,organization_id) do update
   set full_name=excluded.full_name,photo_url=excluded.photo_url,updated_at=now()
   where (agency_user_profiles.full_name,agency_user_profiles.photo_url) is distinct from (excluded.full_name,excluded.photo_url);
  -- This is nested under the membership trigger; the old local sync skips it.
  update agency_collaborators set full_name=identity.full_name,photo_url=identity.photo_url,updated_at=now()
   where user_id=new.user_id and organization_id=new.organization_id
   and (full_name,photo_url) is distinct from (identity.full_name,identity.photo_url);
  return new;
 end if;
 -- Only a private demo owner may receive an initial snapshot. Never overwrite it.
 insert into agency_user_profiles(user_id,organization_id,full_name,photo_url)
 select new.user_id,new.organization_id,g.full_name,g.photo_url
 from user_personal_identities g join users u on u.id=g.user_id
 join organizations o on o.id=new.organization_id
 where g.user_id=new.user_id and not u.is_demo_guest and o.active
 and o.demo_owner_user_id=new.user_id and o.demo_expires_at>now()
 and exists(select 1 from organization_person_identity i where i.user_id=new.user_id and not i.is_demo)
 on conflict(user_id,organization_id) do nothing;
 return new;
end $$;
drop trigger if exists membership_personal_identity on organization_members;
create trigger membership_personal_identity after insert or update of active,removed_at on organization_members
 for each row execute function seed_membership_personal_identity();
