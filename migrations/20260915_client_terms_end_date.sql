-- A commercial agreement can end: from its end month on it stops contributing
-- to the contracted recurring income forecast and commissions.
alter table agency_client_commercial_terms add column if not exists ends_on date;
alter table agency_client_commercial_terms drop constraint if exists agency_client_commercial_terms_ends_check;
alter table agency_client_commercial_terms add constraint agency_client_commercial_terms_ends_check check(ends_on is null or starts_on is null or ends_on>=starts_on);
