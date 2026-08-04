#!/usr/bin/env node
// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
//
// Dev seed: populates the local database with demo channels ("Night Shift
// Demo", "Morning Show Demo") so the app surfaces render populated for design
// review — two channels, so multi-channel tenants can be exercised locally.
// Never runs in migrations, never touches production — every row it writes is
// tied to the channel ids in SEED_CHANNELS below.
//
// Usage:
//   node --env-file=.env scripts/seed-dev.mjs          insert demo rows
//   node --env-file=.env scripts/seed-dev.mjs --reset  delete every demo row

import { createClient } from '@libsql/client';

// commentPrefix keeps comment ids globally unique across channels (comments.id
// is the primary key). Both channels are orphans (user_id/org_id NULL): the
// first user to sign in claims them into their personal org, giving that
// tenant two channels for local multi-channel testing.
const SEED_CHANNELS = [
	{ id: 'seed-UC-night-shift', title: 'Night Shift Demo', commentPrefix: 'seed-comment' },
	{ id: 'seed-UC-morning-show', title: 'Morning Show Demo', commentPrefix: 'seed-morning-comment' }
];

const databaseUrl = process.env.TURSO_DATABASE_URL;
if (!databaseUrl) {
	console.error('TURSO_DATABASE_URL is not set. Run with: node --env-file=.env scripts/seed-dev.mjs');
	process.exit(1);
}
const isLocalUrl = databaseUrl === ':memory:' || databaseUrl.startsWith('file:');
if (!isLocalUrl) {
	console.error(
		`Refusing to seed a non-local database (${databaseUrl}). This script is for local dev only.`
	);
	process.exit(1);
}

const client = createClient({ url: databaseUrl });

const TABLES = ['channels', 'rules', 'comments', 'moderation_actions', 'audit_log'];
for (const table of TABLES) {
	try {
		await client.execute(`SELECT 1 FROM ${table} LIMIT 1`);
	} catch {
		console.error(`Table "${table}" is missing. Run migrations first: npm run db:migrate`);
		process.exit(1);
	}
}

const CHILD_TABLES = ['audit_log', 'moderation_actions', 'comments', 'rules'];

if (process.argv.includes('--reset')) {
	for (const { id } of SEED_CHANNELS) {
		for (const table of CHILD_TABLES) {
			await client.execute({ sql: `DELETE FROM ${table} WHERE channel_id = ?`, args: [id] });
		}
		await client.execute({ sql: 'DELETE FROM channels WHERE id = ?', args: [id] });
	}
	console.log(`Removed all demo rows for ${SEED_CHANNELS.map((c) => c.id).join(', ')}.`);
	process.exit(0);
}

for (const { id } of SEED_CHANNELS) {
	const existing = await client.execute({ sql: 'SELECT id FROM channels WHERE id = ?', args: [id] });
	if (existing.rows.length > 0) {
		console.error(`Demo channel ${id} already exists. Run with --reset first to reseed.`);
		process.exit(1);
	}
}

const day = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const score = (toxicity) =>
	JSON.stringify({
		toxicity,
		severe_toxicity: toxicity * 0.4,
		obscene: toxicity * 0.6,
		threat: toxicity * 0.1,
		insult: toxicity * 0.7,
		identity_attack: toxicity * 0.2
	});

// status / decidedBy / matchedRuleType / aiScore / text — shared demo shape;
// each channel gets its own copy under its own comment-id prefix.
const COMMENTS = [
	['pending', 'none', null, null, 'First time watching — the editing on this one is unreal. How long did the intro take?'],
	['pending', 'none', null, null, 'lol the algorithm brought me here at 2am and I regret nothing'],
	['pending', 'none', null, null, 'Great video as always. Small correction at 4:12 — the spec you quoted is from the 2019 revision, not 2021.'],
	['pending', 'none', null, null, 'check out my channel for free crypto giveaway!!!'],
	['approved', 'ai', null, score(0.04), 'This series got me through my exams. Thank you for keeping the comment section sane.'],
	['approved', 'human', null, null, 'Question: will you cover the follow-up topic next week? The way you explained it finally made it click.'],
	['approved', 'ai', null, score(0.11), 'Been here since 500 subs. The production jump lately is wild.'],
	['held', 'ai', null, score(0.52), 'I disagree with almost everything here and honestly the host annoys me, but the research is solid.'],
	['held', 'rule', 'regex', null, 'I made a playlist about this exact topic https://example.com/my-take would love feedback'],
	['held', 'none', null, null, 'Not sure how I feel about this take. Usually love the channel but this one missed for me.'],
	['rejected', 'ai', null, score(0.91), 'Absolute garbage take, delete your channel.'],
	['rejected', 'rule', 'user', null, 'Another trash video. Everyone who watches this is an idiot.'],
	['deleted', 'rule', 'keyword', null, 'crypto giveaway alert!! double your coins today, limited spots'],
	['deleted', 'human', null, null, 'spam link farm dot com best prices']
];

async function seedChannel({ id, title, commentPrefix }) {
	await client.execute({
		sql: `INSERT INTO channels (id, title, refresh_token_enc, cursor, active)
		      VALUES (?, ?, 'seed-not-a-real-token', ?, 1)`,
		args: [id, title, iso(2 * day)]
	});

	const rules = [
		{ type: 'keyword', pattern: 'crypto giveaway', action: 'delete' },
		{ type: 'regex', pattern: '^https?://', action: 'hold' },
		{ type: 'user', pattern: 'seed-UC-troll', action: 'reject' }
	];
	for (const r of rules) {
		await client.execute({
			sql: 'INSERT INTO rules (channel_id, type, pattern, action) VALUES (?, ?, ?, ?)',
			args: [id, r.type, r.pattern, r.action]
		});
	}
	const ruleIds = await client.execute({
		sql: 'SELECT id, type FROM rules WHERE channel_id = ? ORDER BY id',
		args: [id]
	});
	const ruleIdByType = Object.fromEntries(ruleIds.rows.map((r) => [r.type, r.id]));

	const commentId = (i) => `${commentPrefix}-${String(i + 1).padStart(2, '0')}`;
	for (let i = 0; i < COMMENTS.length; i++) {
		const [status, decidedBy, ruleType, aiScore, text] = COMMENTS[i];
		if (text.length > 500) {
			console.error(`Seed comment #${i + 1} exceeds 500 chars — shorten it.`);
			process.exit(1);
		}
		await client.execute({
			sql: `INSERT INTO comments
			      (id, channel_id, text, published_at, status, decided_by, matched_rule_id, ai_score)
			      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				commentId(i),
				id,
				text,
				iso((i + 1) * 3 * 60 * 60 * 1000),
				status,
				decidedBy,
				ruleType ? ruleIdByType[ruleType] : null,
				aiScore
			]
		});
	}

	const actions = [
		[commentId(11), 'reject', 'rule #3 (user)', 'completed'],
		[commentId(12), 'delete', 'rule #1 (keyword)', 'completed'],
		[commentId(10), 'reject', 'ai score 0.91', 'dispatched']
	];
	for (const [cid, action, reason, state] of actions) {
		await client.execute({
			sql: `INSERT INTO moderation_actions (comment_id, channel_id, action, reason, state, last_attempt_at)
			      VALUES (?, ?, ?, ?, ?, ?)`,
			args: [cid, id, action, reason, state, iso(6 * 60 * 60 * 1000)]
		});
	}

	const logRows = [
		[commentId(4), 'approve', 'ai score 0.04', 'system'],
		[commentId(5), 'approve', 'manual approve', 'user'],
		[commentId(7), 'queue', 'ai score 0.52', 'system'],
		[commentId(8), 'hold', 'rule #2 (regex)', 'system'],
		[commentId(10), 'reject', 'ai score 0.91', 'system'],
		[commentId(11), 'reject', 'rule #3 (user)', 'system'],
		[commentId(12), 'delete', 'rule #1 (keyword)', 'system'],
		[commentId(13), 'delete', 'manual delete', 'user'],
		[commentId(3), 'dry-run', 'would queue (ai unavailable)', 'system']
	];
	for (const [cid, action, reason, actor] of logRows) {
		await client.execute({
			sql: 'INSERT INTO audit_log (channel_id, comment_id, action, reason, actor) VALUES (?, ?, ?, ?, ?)',
			args: [id, cid, action, reason, actor]
		});
	}

	return { rules: rules.length, comments: COMMENTS.length, actions: actions.length, logRows: logRows.length };
}

for (const channel of SEED_CHANNELS) {
	const counts = await seedChannel(channel);
	console.log(
		`Seeded ${channel.id}: 1 channel, ${counts.rules} rules, ${counts.comments} comments, ` +
			`${counts.actions} moderation actions, ${counts.logRows} audit log rows.`
	);
}
console.log('Undo with: node --env-file=.env scripts/seed-dev.mjs --reset');
