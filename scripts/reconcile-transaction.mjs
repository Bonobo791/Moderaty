function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Apply and verify migration-hash updates atomically.
 *
 * A failed commit has indeterminate durability when the connection fails, so
 * a rollback failure must never be reported as a clean rollback.
 */
export async function applyReconciliationTransaction(tx, changes) {
	try {
		for (const change of changes) {
			const result = await tx.execute({
				sql: 'UPDATE __drizzle_migrations SET hash = ? WHERE rowid = ?',
				args: [change.journalHash, change.rowid]
			});
			if (Number(result.rowsAffected) !== 1) {
				throw new Error(`UPDATE for rowid ${change.rowid} (${change.tag}) affected ${result.rowsAffected} rows`);
			}
			const check = await tx.execute({
				sql: 'SELECT hash FROM __drizzle_migrations WHERE rowid = ?',
				args: [change.rowid]
			});
			if (check.rows.length !== 1 || String(check.rows[0].hash) !== change.journalHash) {
				throw new Error(`read-back for rowid ${change.rowid} (${change.tag}) did not show the new hash`);
			}
		}
		await tx.commit();
	} catch (error) {
		try {
			await tx.rollback();
		} catch (rollbackError) {
			throw new Error(
				`reconciliation state is UNKNOWN: update failed (${errorMessage(error)}), and rollback failed (${errorMessage(rollbackError)}). ` +
					'Read back __drizzle_migrations before retrying.',
				{ cause: rollbackError }
			);
		}
		throw new Error(`reconciliation update failed and was rolled back (${errorMessage(error)})`, { cause: error });
	}
}
