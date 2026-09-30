UPDATE `stripe_auto_topup_recoveries`
SET `customer_id` = (
	SELECT `stripe_customer_id` FROM `organizations`
	WHERE `organizations`.`id` = `stripe_auto_topup_recoveries`.`org_id`
)
WHERE `customer_id` IS NULL;
