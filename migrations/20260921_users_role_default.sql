-- Los usuarios ya no nacen con rol administrativo. La autorización real sale de
-- organization_members.role, pero el default de users.role deja de ser 'admin':
-- cualquier insert futuro queda como 'viewer' hasta que una membresía diga otra cosa.
alter table users alter column role set default 'viewer';
