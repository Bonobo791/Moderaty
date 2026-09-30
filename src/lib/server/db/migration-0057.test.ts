import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import { applyMigration, closeMigratedDbs } from './migrationTestUtils';

afterEach(closeMigratedDbs);

test('restores the exact dev-applied refund migration and its original ordering', () => {
	const journal = JSON.parse(readFileSync(new URL('../../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
	const entry = journal.entries.find((row: { tag: string }) => row.tag === '0057_review_refund_observations');
	expect(entry).toMatchObject({ idx: 57, when: 1790801496704 });
	const sql = readFileSync(new URL('../../../../drizzle/0057_review_refund_observations.sql', import.meta.url));
	expect(createHash('sha256').update(sql).digest('hex')).toBe('25563e3211b472f5c131c7c8d4be79baf301d22a86b24ed92ab72b8828d64611');
});

test('restored migration preserves existing recovery identity and cursor', async () => {
	const client = await applyMigration(`
		CREATE TABLE stripe_auto_topup_recoveries (id INTEGER PRIMARY KEY, customer_id TEXT, resolved_at TEXT, payment_intent_id TEXT, payment_lookup_cursor TEXT);
	`, '0057_review_refund_observations.sql', `
		INSERT INTO stripe_auto_topup_recoveries VALUES (7, 'cus_test', NULL, 'pi_test', 'pi_page');
	`);
	expect((await client.execute('SELECT * FROM stripe_auto_topup_recoveries')).rows).toEqual([
		{ id: 7, customer_id: 'cus_test', resolved_at: null, payment_intent_id: 'pi_test', payment_lookup_cursor: 'pi_page', lookup_cursor: null, lookup_candidate_id: null }
	]);
	await client.execute("INSERT INTO stripe_refund_observations (charge_id, refunded_amount_cents, occurred_at) VALUES ('ch_test', 100, '2026-09-30T13:10:00.000Z')");
	expect((await client.execute('SELECT org_id, refunded_amount_cents FROM stripe_refund_observations')).rows).toEqual([{ org_id: null, refunded_amount_cents: 100 }]);
	expect((await client.execute("PRAGMA index_info('stripe_auto_topup_recoveries_customer_idx')")).rows.map(row => row.name)).toEqual(['customer_id', 'resolved_at']);
	expect((await client.execute('PRAGMA integrity_check')).rows[0]).toEqual({ integrity_check: 'ok' });
});
