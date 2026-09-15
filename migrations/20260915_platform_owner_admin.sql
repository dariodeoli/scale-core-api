-- The boot-time owner grant records its own audited action.
alter table platform_bootstrap_audit_log drop constraint if exists platform_bootstrap_audit_log_action_check;
alter table platform_bootstrap_audit_log add constraint platform_bootstrap_audit_log_action_check check(action in ('initial_admin_granted','owner_admin_ensured'));
