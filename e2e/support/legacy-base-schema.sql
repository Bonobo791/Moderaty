-- The four pre-0000 tables predate the migration journal (drizzle-kit push).
-- Same historical baseline documented by scripts/seed-dev.test.mjs; this is
-- fixture schema data, not a replacement for current migrations.
CREATE TABLE channels (
	id text PRIMARY KEY NOT NULL,
	title text NOT NULL,
	refresh_token_enc text NOT NULL,
	cursor text,
	active integer NOT NULL DEFAULT 1,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE rules (
	id integer PRIMARY KEY AUTOINCREMENT,
	channel_id text NOT NULL,
	type text NOT NULL,
	pattern text NOT NULL,
	action text NOT NULL,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE comments (
	id text PRIMARY KEY NOT NULL,
	channel_id text NOT NULL,
	author_channel_id text,
	author_name text,
	text text NOT NULL,
	published_at text NOT NULL,
	status text NOT NULL,
	decided_by text NOT NULL,
	matched_rule_id integer,
	ai_score text,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE audit_log (
	id integer PRIMARY KEY AUTOINCREMENT,
	channel_id text NOT NULL,
	comment_id text NOT NULL,
	action text NOT NULL,
	reason text NOT NULL,
	actor text NOT NULL,
	created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
