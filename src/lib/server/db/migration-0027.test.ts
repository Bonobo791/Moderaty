// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

import { afterEach, expect, test } from 'vitest';

import { applyMigration, closeMigratedDbs } from './migrationTestUtils';

// Behavior test for migration 0027 (stripe receipt + reversal keys): the
// pending-reversal dedupe moves from charge_id-only to UNIQUE(charge_id,
// reason), and the stripe_events (event_type, object_id) anchor stops being
// UNIQUE. Both restore the full codex review semantics: a dispute AND a
// later full refund can both queue for the same charge, and later events for
// the same object are processed (idempotently) instead of being suppressed.
const MIGRATION = '0027_stripe_receipt_and_reversal_keys.sql';

afterEach(closeMigratedDbs);

test('migration 0027 keys pending reversals by (charge_id, reason) and de-uniques the events (type, object) anchor', async () => {
	// Pre-0027 state: stripe_pending_reversals with the charge_id-only UNIQUE,
	// and stripe_events with the UNIQUE (event_type, object_id) anchor.
	const preDdl = `
		CREATE TABLE stripe_pending_reversals (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			charge_id TEXT NOT NULL,
			reason TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
		CREATE UNIQUE INDEX stripe_pending_reversals_charge_id_unique ON stripe_pending_reversals (charge_id);
		CREATE TABLE stripe_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id TEXT NOT NULL UNIQUE,
			event_type TEXT NOT NULL,
			object_id TEXT NOT NULL,
			object_type TEXT NOT NULL,
			received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			processed_at TEXT
		);
		CREATE UNIQUE INDEX stripe_events_type_object_idx ON stripe_events (event_type, object_id);
	`;
	const client = await applyMigration(preDdl, MIGRATION);

	// The charge_id-only UNIQUE is gone; the (charge_id, reason) pair is now
	// the unique anchor.
	const reversalIndexes = await client.execute("PRAGMA index_list('stripe_pending_reversals')");
	const reversalIndexNames = reversalIndexes.rows.map((row) => String(row.name));
	expect(reversalIndexNames).not.toContain('stripe_pending_reversals_charge_id_unique');
	expect(reversalIndexNames).toContain('stripe_pending_reversals_charge_reason_idx');

	// Both reasons for the SAME charge can now coexist.
	await client.executeMultiple(`
		INSERT INTO stripe_pending_reversals (charge_id, reason) VALUES ('ch_1', 'dispute');
		INSERT INTO stripe_pending_reversals (charge_id, reason) VALUES ('ch_1', 'refund');
	`);
	const both = await client.execute("SELECT reason FROM stripe_pending_reversals WHERE charge_id = 'ch_1' ORDER BY reason");
	expect(both.rows.map((row) => String(row.reason))).toEqual(['dispute', 'refund']);

	// A duplicate (charge, reason) is still rejected — the idempotency anchor.
	await expect(
		client.execute("INSERT INTO stripe_pending_reversals (charge_id, reason) VALUES ('ch_1', 'refund')")
	).rejects.toThrow('UNIQUE');

	// The stripe_events (type, object) index survives as a NON-unique index.
	const eventsIndexes = await client.execute("PRAGMA index_list('stripe_events')");
	const eventsIndexNames = eventsIndexes.rows.map((row) => String(row.name));
	expect(eventsIndexNames).toContain('stripe_events_type_object_idx');
	const unique = await client.execute("PRAGMA index_info('stripe_events_type_object_idx')");
	expect(unique.rows).toHaveLength(2); // (event_type, object_id)
	// Two DIFFERENT event ids for the same type+object must both insert.
	await client.executeMultiple(`
		INSERT INTO stripe_events (event_id, event_type, object_id, object_type) VALUES ('evt_1', 'charge.refunded', 'ch_1', 'charge');
		INSERT INTO stripe_events (event_id, event_type, object_id, object_type) VALUES ('evt_2', 'charge.refunded', 'ch_1', 'charge');
	`);
	const events = await client.execute("SELECT event_id FROM stripe_events WHERE object_id = 'ch_1' ORDER BY event_id");
	expect(events.rows.map((row) => String(row.event_id))).toEqual(['evt_1', 'evt_2']);
	// The exact-delivery anchor (event_id) stays unique.
	await expect(
		client.execute("INSERT INTO stripe_events (event_id, event_type, object_id, object_type) VALUES ('evt_1', 'charge.refunded', 'ch_1', 'charge')")
	).rejects.toThrow('UNIQUE');
});
