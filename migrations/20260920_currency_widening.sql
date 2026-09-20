-- Cierre del soporte de las seis monedas (iniciado en 20260910_currencies.sql):
-- gastos planificados, términos comerciales y salario mensual del colaborador
-- seguían limitados a PYG|USD, así que el front ofrecía EUR/BRL/ARS/MXN y el
-- API respondía 400 (y la base rechazaba la fila).
-- Aditiva, idempotente y re-ejecutable: quita cada check por nombre y lo vuelve
-- a crear con la lista de currencies.js (PYG, USD, EUR, BRL, ARS, MXN).
do $$ declare t text; begin
 foreach t in array array['agency_client_commercial_terms','agency_planned_expenses'] loop
  execute format('alter table %I drop constraint if exists %I',t,t||'_currency_check');
  execute format('alter table %I add constraint %I check(currency in (''PYG'',''USD'',''EUR'',''BRL'',''ARS'',''MXN''))',t,t||'_currency_check');
 end loop;
end $$;
-- El check compuesto del salario mensual conserva su semántica: monto y moneda
-- van juntos y el importe no puede ser negativo. Solo se amplía la lista.
alter table agency_collaborators drop constraint if exists agency_collaborators_monthly_salary_check;
alter table agency_collaborators add constraint agency_collaborators_monthly_salary_check check (
 (monthly_salary_amount is null and monthly_salary_currency is null)
 or (monthly_salary_amount is not null and monthly_salary_amount >= 0 and monthly_salary_currency in ('PYG','USD','EUR','BRL','ARS','MXN'))
);
