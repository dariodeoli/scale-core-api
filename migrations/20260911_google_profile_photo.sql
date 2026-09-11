-- Verified Google profile fallback; personal photos always take precedence.
alter table users add column if not exists google_photo_url text;
alter table users add column if not exists google_full_name text;
