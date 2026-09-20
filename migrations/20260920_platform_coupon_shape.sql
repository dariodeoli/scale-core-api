-- Coherencia de forma de los cupones globales: cada tipo define su moneda y su valor.
-- La migración de cupones por días (20260915_coupon_free_days.sql) quitó el check
-- compuesto y no lo repuso, así que cualquier escritura ajena al API podía guardar
-- un cupón incoherente que el consumo después interpreta mal.
-- Aditiva, idempotente y re-ejecutable: primero quita el check por nombre y lo vuelve
-- a crear; `not valid` no revalida las filas históricas (el arranque nunca falla por
-- datos viejos) pero sí exige la forma en toda escritura nueva.
alter table platform_coupons drop constraint if exists platform_coupons_shape_check;
alter table platform_coupons add constraint platform_coupons_shape_check check (
  (discount_type = 'percent' and currency is null and discount_value > 0 and discount_value <= 100)
  or (discount_type = 'fixed' and currency is not null and discount_value > 0)
  or (discount_type = 'days' and currency is null and discount_value = floor(discount_value) and discount_value >= 1 and discount_value <= 3650)
) not valid;
