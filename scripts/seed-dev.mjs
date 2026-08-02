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
// Dev seed: populates the local database with a demo channel ("Night Shift
// Demo") so the app surfaces render populated for design review. Never runs
// in migrations, never touches production — every row it writes is tied to
// the channel id seed-UC-night-shift.
//
// Usage:
//   node --env-file=.env scripts/seed-dev.mjs          insert demo rows
//   node --env-file=.env scripts/seed-dev.mjs --reset  delete every demo row

import { createClient } from '@libsql/client';

const CHANNEL_ID = 'seed-UC-night-shift';

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

if (process.argv.includes('--reset')) {
	await client.execute({ sql: 'DELETE FROM audit_log WHERE channel_id = ?', args: [CHANNEL_ID] });
	await client.execute({
		sql: 'DELETE FROM moderation_actions WHERE channel_id = ?',
		args: [CHANNEL_ID]
	});
	await client.execute({ sql: 'DELETE FROM comments WHERE channel_id = ?', args: [CHANNEL_ID] });
	await client.execute({ sql: 'DELETE FROM rules WHERE channel_id = ?', args: [CHANNEL_ID] });
	await client.execute({ sql: 'DELETE FROM channels WHERE id = ?', args: [CHANNEL_ID] });
	console.log(`Removed all demo rows for ${CHANNEL_ID}.`);
	process.exit(0);
}

const existing = await client.execute({
	sql: 'SELECT id FROM channels WHERE id = ?',
	args: [CHANNEL_ID]
});
if (existing.rows.length > 0) {
	console.error(`Demo channel ${CHANNEL_ID} already exists. Run with --reset first to reseed.`);
	process.exit(1);
}

const day = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

await client.execute({
	sql: `INSERT INTO channels (id, title, refresh_token_enc, cursor, active)
	      VALUES (?, ?, 'seed-not-a-real-token', ?, 1)`,
	args: [CHANNEL_ID, 'Night Shift Demo', iso(2 * day)]
});

const rules = [
	{ id: 1, type: 'keyword', pattern: 'crypto giveaway', action: 'delete' },
	{ id: 2, type: 'regex', pattern: '^https?://', action: 'hold' },
	{ id: 3, type: 'user', pattern: 'seed-UC-troll', action: 'reject' }
];
for (const r of rules) {
	await client.execute({
		sql: 'INSERT INTO rules (channel_id, type, pattern, action) VALUES (?, ?, ?, ?)',
		args: [CHANNEL_ID, r.type, r.pattern, r.action]
	});
}
const ruleIds = await client.execute({
	sql: 'SELECT id, type FROM rules WHERE channel_id = ? ORDER BY id',
	args: [CHANNEL_ID]
});
const ruleIdByType = Object.fromEntries(ruleIds.rows.map((r) => [r.type, r.id]));

const score = (toxicity) =>
	JSON.stringify({
		toxicity,
		severe_toxicity: toxicity * 0.4,
		obscene: toxicity * 0.6,
		threat: toxicity * 0.1,
		insult: toxicity * 0.7,
		identity_attack: toxicity * 0.2
	});

// status / decidedBy / matchedRuleType / aiScore / text
const comments = [
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

for (let i = 0; i < comments.length; i++) {
	const [status, decidedBy, ruleType, aiScore, text] = comments[i];
	if (text.length > 500) {
		console.error(`Seed comment #${i + 1} exceeds 500 chars — shorten it.`);
		process.exit(1);
	}
	await client.execute({
		sql: `INSERT INTO comments
		      (id, channel_id, text, published_at, status, decided_by, matched_rule_id, ai_score)
		      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			`seed-comment-${String(i + 1).padStart(2, '0')}`,
			CHANNEL_ID,
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
	['seed-comment-12', 'reject', 'rule #3 (user)', 'completed'],
	['seed-comment-13', 'delete', 'rule #1 (keyword)', 'completed'],
	['seed-comment-11', 'reject', 'ai score 0.91', 'dispatched']
];
for (const [commentId, action, reason, state] of actions) {
	await client.execute({
		sql: `INSERT INTO moderation_actions (comment_id, channel_id, action, reason, state, last_attempt_at)
		      VALUES (?, ?, ?, ?, ?, ?)`,
		args: [commentId, CHANNEL_ID, action, reason, state, iso(6 * 60 * 60 * 1000)]
	});
}

const logRows = [
	['seed-comment-05', 'approve', 'ai score 0.04', 'system'],
	['seed-comment-06', 'approve', 'manual approve', 'user'],
	['seed-comment-08', 'queue', 'ai score 0.52', 'system'],
	['seed-comment-09', 'hold', 'rule #2 (regex)', 'system'],
	['seed-comment-11', 'reject', 'ai score 0.91', 'system'],
	['seed-comment-12', 'reject', 'rule #3 (user)', 'system'],
	['seed-comment-13', 'delete', 'rule #1 (keyword)', 'system'],
	['seed-comment-14', 'delete', 'manual delete', 'user'],
	['seed-comment-04', 'dry-run', 'would queue (ai unavailable)', 'system']
];
for (const [commentId, action, reason, actor] of logRows) {
	await client.execute({
		sql: 'INSERT INTO audit_log (channel_id, comment_id, action, reason, actor) VALUES (?, ?, ?, ?, ?)',
		args: [CHANNEL_ID, commentId, action, reason, actor]
	});
}

console.log(
	`Seeded ${CHANNEL_ID}: 1 channel, ${rules.length} rules, ${comments.length} comments, ` +
		`${actions.length} moderation actions, ${logRows.length} audit log rows.`
);
console.log('Undo with: node --env-file=.env scripts/seed-dev.mjs --reset');
