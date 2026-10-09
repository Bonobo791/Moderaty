DELETE FROM channel_allowed_handles WHERE id NOT IN
  (SELECT MAX(id) FROM channel_allowed_handles GROUP BY channel_id, handle);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_allowed_handles_channel_handle_unique` ON `channel_allowed_handles` (`channel_id`,`handle`);--> statement-breakpoint
ALTER TABLE `channel_allowed_handles` DROP COLUMN `resolved_channel_id`;