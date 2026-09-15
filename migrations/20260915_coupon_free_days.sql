-- Coupons can also grant a number of free days instead of a discount.
alter table platform_coupons drop constraint if exists platform_coupons_discount_type_check;
alter table platform_coupons drop constraint if exists platform_coupons_check;
alter table platform_coupons add constraint platform_coupons_discount_type_check check(discount_type in ('percent','fixed','days'));
