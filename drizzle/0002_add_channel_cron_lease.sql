ALTER TABLE channels ADD last_run_at text;
--> statement-breakpoint
ALTER TABLE channels ADD lease_expires_at text;
