-- Issue #77: the dashboard ban counter (action='ban' + channel_id IN,
-- GROUP BY channel_id) and the per-channel log page (channel_id =) both
-- full-scan audit_log, which grows with every moderation decision. The
-- composite serves the ban query; its leftmost column serves channel-only
-- reads. Expand-only (I7): index creation touches no rows.
CREATE INDEX `audit_log_channel_action_idx` ON `audit_log` (`channel_id`,`action`);
