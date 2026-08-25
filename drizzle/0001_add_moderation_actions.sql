CREATE TABLE moderation_actions (
	comment_id text PRIMARY KEY NOT NULL,
	channel_id text NOT NULL,
	action text NOT NULL,
	reason text NOT NULL,
	state text NOT NULL,
	last_attempt_at text,
	last_manual_retry_at text,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
--> statement-breakpoint
CREATE INDEX moderation_actions_channel_state_idx ON moderation_actions (channel_id, state);
