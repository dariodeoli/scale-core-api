do $$ declare t text;begin
 foreach t in array array['agency_budgets','bank_accounts','agency_invoices','agency_collaborators','agency_commissions','agency_plans','agency_leads','agency_inventory'] loop
  execute format('alter table %I drop constraint if exists %I',t,t||'_currency_check');
  execute format('alter table %I add constraint %I check(currency in (''PYG'',''USD'',''EUR'',''BRL'',''ARS'',''MXN''))',t,t||'_currency_check');
 end loop;
end $$;
