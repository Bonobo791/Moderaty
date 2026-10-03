CREATE TABLE `welcome_campaigns` (
	`campaign` text PRIMARY KEY NOT NULL,
	`next_attempt_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `welcome_campaigns` (`campaign`, `next_attempt_at`)
SELECT `campaign`, max(max(
	coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', `last_attempt_at`, '+60 seconds'), '1970-01-01T00:00:00.000Z'),
	CASE WHEN `state` IN ('claimed', 'in_flight') THEN coalesce(`lease_expires_at`, '1970-01-01T00:00:00.000Z') ELSE '1970-01-01T00:00:00.000Z' END,
	CASE WHEN `state` = 'queued' AND `last_error` IN ('configuration', 'authentication', 'tls', 'dns') AND `accepted_at` IS NULL AND `suppression_reason` IS NULL THEN coalesce(`next_retry_at`, '1970-01-01T00:00:00.000Z') ELSE '1970-01-01T00:00:00.000Z' END
))
FROM `welcome_emails`
GROUP BY `campaign`;
