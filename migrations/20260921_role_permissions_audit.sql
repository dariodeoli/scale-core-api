-- La UI promete que los cambios de permisos se auditan (app/permissions-matrix.tsx).
-- El trigger compartido de agency_operation_audit se adjunta a agency_role_permissions
-- para registrar actor, IP y el antes/después de cada override.
drop trigger if exists operation_audit on agency_role_permissions;
create trigger operation_audit after insert or update or delete on agency_role_permissions
 for each row execute function audit_agency_operation();
