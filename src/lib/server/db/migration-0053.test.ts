import { afterEach, expect, test } from 'vitest';
import { applyMigration, closeMigratedDbs, migrationStatements } from './migrationTestUtils';

afterEach(closeMigratedDbs);

test('refund recovery migrations preserve obligations, backfill customers, and remove deletion cascades', async () => {
	const ddl = `
		CREATE TABLE organizations (id TEXT PRIMARY KEY, stripe_customer_id TEXT);
		CREATE TABLE mercado_pago_checkout_attempts (id INTEGER PRIMARY KEY);
		CREATE TABLE stripe_pending_reversals (id INTEGER PRIMARY KEY);
		${migrationStatements('0052_auto_topup_refund_recovery.sql').join('\n')}
	`;
	const client = await applyMigration(ddl, '0053_refund_recovery_review.sql', `
		INSERT INTO organizations VALUES ('org-1', 'cus_1');
		INSERT INTO stripe_auto_topup_recoveries (id, org_id, attempt_at, payment_intent_id, refund_id, last_error) VALUES (7, 'org-1', '2026-09-30T13:10:00.000Z', 'pi_1', 're_pending', 'refund_or_cancellation_failed');
	`);
	const read = () => client.execute('SELECT * FROM stripe_auto_topup_recoveries WHERE id = 7');
	expect((await read()).rows[0]).toMatchObject({ id: 7, org_id: 'org-1', customer_id: null, payment_intent_id: 'pi_1', refund_id: 're_pending', resolved_at: null, last_error: 'refund_or_cancellation_failed' });
	for (const statement of migrationStatements('0054_backfill_refund_recovery_customers.sql')) await client.execute(statement);
	expect((await read()).rows[0].customer_id).toBe('cus_1');
	await client.execute("UPDATE organizations SET stripe_customer_id = 'cus_changed'");
	for (const statement of migrationStatements('0054_backfill_refund_recovery_customers.sql')) await client.execute(statement);
	expect((await read()).rows[0].customer_id).toBe('cus_1');
	await client.execute("DELETE FROM organizations WHERE id = 'org-1'");
	expect((await read()).rows[0]).toMatchObject({ payment_intent_id: 'pi_1', refund_id: 're_pending', customer_id: 'cus_1' });
	expect((await client.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
	expect((await client.execute('PRAGMA integrity_check')).rows[0].integrity_check).toBe('ok');
	const plan = await client.execute("EXPLAIN QUERY PLAN SELECT * FROM stripe_auto_topup_recoveries WHERE org_id = 'org-1' AND payment_intent_id = 'pi_1'");
	expect(plan.rows.map((r) => r.detail).join(' ')).toContain('stripe_auto_topup_recoveries_payment_idx');
});
