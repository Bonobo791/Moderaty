/** Pending intent and unsettled dispatch ownership both fence automatic rescans. */
export function hasHumanClaim(row: { status: string; humanDispatchToken: string | null; humanDispatchState: string | null }): boolean {
	return row.status === 'restoring' || row.humanDispatchToken !== null || row.humanDispatchState !== null;
}
