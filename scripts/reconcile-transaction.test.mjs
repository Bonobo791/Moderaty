import { describe, expect, test, vi } from 'vitest';
import { applyReconciliationTransaction } from './reconcile-transaction.mjs';

function transaction({ failRollback = false } = {}) {
	let updates = 0;
	return {
		execute: vi.fn(async ({ sql }) => {
			if (sql.startsWith('UPDATE')) {
				updates += 1;
				if (updates === 2) throw new Error('forced update failure');
				return { rowsAffected: 1, rows: [] };
			}
			return { rowsAffected: 0, rows: [{ hash: 'new-hash' }] };
		}),
		commit: vi.fn(),
		rollback: vi.fn(async () => {
			if (failRollback) throw new Error('rollback unavailable');
		})
	};
}

describe('applyReconciliationTransaction', () => {
	test('reports an unknown state when rollback fails', async () => {
		const tx = transaction({ failRollback: true });

		await expect(
			applyReconciliationTransaction(tx, [
				{ rowid: 1, tag: '0001_first', journalHash: 'new-hash' },
				{ rowid: 2, tag: '0002_second', journalHash: 'new-hash' }
			])
		).rejects.toThrow(/UNKNOWN.*rollback unavailable.*read back/i);
		expect(tx.rollback).toHaveBeenCalledOnce();
	});
});
