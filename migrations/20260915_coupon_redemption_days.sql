-- Free-days coupons record zero granted months on redemption.
alter table platform_coupon_redemptions drop constraint if exists platform_coupon_redemptions_months_granted_check;
alter table platform_coupon_redemptions add constraint platform_coupon_redemptions_months_granted_check check(months_granted >= 0);
