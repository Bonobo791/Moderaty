-- Moderaty — YouTube Comment Auto-Moderation Tool
-- Copyright (C) 2026 Andrew Philip Weilbacher
--
-- Licensed under the PolyForm Shield License 1.0.0; you may not use
-- this file except in compliance with the License. You may obtain a
-- copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
--
-- The software is provided "as is", without warranty or condition of
-- any kind, express or implied. See the License for the specific
-- language governing permissions and limitations under the License.
-- A copy of the License is included in the LICENSE file at the
-- repository root.
--
-- Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

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
