-- Platform administrators carry an explicit role: 'admin' manages every
-- control, 'viewer' only inspects. Existing rows and the one-time bootstrap
-- default to 'admin'.
alter table platform_administrators add column if not exists role text not null default 'admin' check(role in ('admin','viewer'));
