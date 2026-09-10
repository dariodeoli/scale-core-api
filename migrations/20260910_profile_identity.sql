-- Personal identity is shared by linked records inside one organization only.
-- Contact email, salary, access role and employment status remain independent.
create or replace function sync_agency_person_identity() returns trigger language plpgsql as $$
begin
 if pg_trigger_depth()>1 then return new; end if;
 if tg_table_name='agency_user_profiles' then
  update agency_collaborators set full_name=new.full_name,photo_url=new.photo_url,updated_at=now()
   where user_id=new.user_id and organization_id=new.organization_id
   and (full_name,photo_url) is distinct from (new.full_name,new.photo_url);
 elsif new.user_id is not null then
  insert into agency_user_profiles(user_id,organization_id,full_name,photo_url)
   values(new.user_id,new.organization_id,new.full_name,new.photo_url)
   on conflict(user_id,organization_id) do update set full_name=excluded.full_name,photo_url=excluded.photo_url,updated_at=now()
   where (agency_user_profiles.full_name,agency_user_profiles.photo_url) is distinct from (excluded.full_name,excluded.photo_url);
 end if;
 return new;
end $$;
drop trigger if exists person_identity_sync on agency_user_profiles;
create trigger person_identity_sync after insert or update of full_name,photo_url on agency_user_profiles
 for each row execute function sync_agency_person_identity();
drop trigger if exists person_identity_sync on agency_collaborators;
create trigger person_identity_sync after insert or update of full_name,photo_url,user_id on agency_collaborators
 for each row execute function sync_agency_person_identity();
-- Bootstrap missing profiles from an explicit user link, never a guessed email.
insert into agency_user_profiles(user_id,organization_id,full_name,photo_url)
 select distinct on(c.user_id,c.organization_id) c.user_id,c.organization_id,c.full_name,c.photo_url
 from agency_collaborators c where c.user_id is not null
 order by c.user_id,c.organization_id,c.updated_at desc,c.id desc
 on conflict do nothing;
-- Existing self-edited profiles win over the formerly disconnected team copy.
update agency_collaborators c set full_name=p.full_name,photo_url=p.photo_url,updated_at=now()
 from agency_user_profiles p where c.user_id=p.user_id and c.organization_id=p.organization_id
 and length(trim(p.full_name))>0
 and (c.full_name,c.photo_url) is distinct from (p.full_name,p.photo_url);
