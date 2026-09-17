-- Administration manages a member photo from the team directory. The API sets
-- app.identity_admin only after members.manage is authorized for the active
-- organization, so the owner rule stays the default for every other writer and
-- the membership check still applies. Removing a photo keeps its tombstone so
-- Google sync never resurrects it.
create or replace function authorize_personal_identity() returns trigger language plpgsql as $$
begin
 if (new.user_id::text is distinct from nullif(current_setting('app.current_user',true),'')
   and current_setting('app.identity_admin',true) is distinct from 'true')
  or (tg_op='UPDATE' and new.user_id is distinct from old.user_id)
  or not exists(select 1 from organization_person_identity i where i.user_id=new.user_id
   and i.organization_id::text=current_setting('app.current_organization',true) and not i.is_demo)
 then raise exception 'Personal identity requires its owner in a real organization' using errcode='42501';end if;
 return new;
end $$;
