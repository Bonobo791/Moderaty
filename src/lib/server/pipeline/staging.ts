import { and, eq, inArray, sql } from 'drizzle-orm';
import { normalizeHandle } from '$lib/server/allowlist';
import { commentChargeRef, consumeCreditsBulk, type LedgerHandle } from '$lib/server/billing/ledger';
import { db } from '$lib/server/db';
import { auditLog, comments, moderationActions } from '$lib/server/db/schema';
import { assertChannelActive, type ChannelIdentity } from './enforcement';
import { hasHumanClaim } from './human-claims';
import type { Decision, RescanCharge } from './types';

/**
 * Builds audit records for moderation decisions.
 *
 * @param dryRun - Whether to mark records as dry-run entries and retain truncated comment text
 * @returns Audit records for decisions with an audit action and reason
 */
export function auditRows(channelId: string, decisions: Decision[], dryRun: boolean) {
	// Stryker disable next-line MethodExpression: equivalent — every Decision producer (ruleDecision, aiUnavailable, aiOutcome) sets auditAction and reason, so the filter never drops a row
	return decisions
		.filter((decision): decision is Decision & { auditAction: string; reason: string } =>
			// Stryker disable next-line ConditionalExpression, LogicalOperator: equivalent — the predicate is constant true for every Decision the pipeline produces, so the operator choice is unobservable
			Boolean(decision.auditAction && decision.reason)
		)
		.map((decision) => {
			// The commenter's normalized handle — the same normalization the
			// allowlist compares against, so a log row reads exactly like a
			// protected-handles entry. normalizeHandle never throws, but a
			// blank/lone-'@' author name trims to '' — store NULL in that case:
			// a handle is either meaningful or absent, never an empty string.
			const authorHandle = normalizeHandle(decision.comment.authorName) || null;
			return {
				channelId,
				commentId: decision.comment.id,
				action: dryRun ? 'dry-run' : decision.auditAction,
				reason: decision.reason,
				actor: 'system',
				authorHandle,
				// Dry run never inserts into comments (I8), so the audit row is the
				// only place the comment text survives — capped at 500 chars like
				// comments.text. Real runs leave it null (text lives in comments).
				...(dryRun ? { text: decision.comment.text.slice(0, 500) } : {}),
				createdAt: new Date().toISOString()
			};
		});
}

function commentRows(channelId: string, decisions: Decision[]) {
	// Process-and-discard for author PII: the display name and author channel
	// ID served their purpose at decision time (rule matching) and are never
	// persisted. Comment text IS stored (≤500 chars) so the review queue works.
	return decisions.map((decision) => ({
		id: decision.comment.id,
		channelId,
		text: decision.comment.text.slice(0, 500),
		publishedAt: decision.comment.publishedAt,
		status: decision.status,
		decidedBy: decision.decidedBy,
		matchedRuleId: decision.matchedRuleId,
		aiScore: decision.aiScore,
		createdAt: new Date().toISOString()
	}));
}

function actionRows(channelId: string, decisions: Decision[]) {
	const createdAt = new Date().toISOString();
	return decisions.flatMap((decision) => {
		if (!decision.youtubeAction) return [];
		// Stryker disable next-line ConditionalExpression, StringLiteral: equivalent — every youtubeAction decision carries a reason (all producers set both), so this guard never fires
		if (!decision.reason) throw new Error(`remote moderation decision ${decision.comment.id} is missing a reason`);
		return [{
			commentId: decision.comment.id,
			channelId,
			action: decision.youtubeAction,
			reason: decision.reason,
			// The normalized handle rides the staged row so the completion audit
			// row (written later by completeActions, long after the comment's
			// in-memory author data is gone) can still say WHO was moderated.
			// Same contract as auditRows: NULL when the name normalizes to ''.
			authorHandle: normalizeHandle(decision.comment.authorName) || null,
			state: 'pending',
			lastAttemptAt: null,
			lastManualRetryAt: null,
			createdAt
		}];
	});
}


/** Rescan-only comment staging: stored rows take the fresh verdict by upsert. */
async function upsertRescannedCommentRows(
	transaction: LedgerHandle,
	channelId: string,
	decisions: Decision[],
	scanStamp: string | null | undefined
): Promise<void> {
	// A user-requested history rescan re-decides stored comments on
	// purpose: the row UPSERTS to the fresh verdict instead of the
	// insert dying on the comments.id primary key. Text/publishedAt
	// refresh too (the YouTube comment may have been edited); the
	// original createdAt and the feedback-digest marker are kept.
	// The scan stamp goes on the row itself: it is THE record that this
	// scan already staged the comment — the parked-page/crash-retry filter
	// reads it to skip verdicts that mint no credit anchor (rule/allowlist,
	// unmetered orgs) as well as billed ones (codex).
	const stamp = scanStamp ?? null;
	await transaction
		.insert(comments)
		.values(commentRows(channelId, decisions).map((row) => ({ ...row, scanId: stamp })))
		.onConflictDoUpdate({
			target: comments.id,
			set: {
				text: sql`excluded.text`,
				publishedAt: sql`excluded.published_at`,
				status: sql`excluded.status`,
				decidedBy: sql`excluded.decided_by`,
				matchedRuleId: sql`excluded.matched_rule_id`,
				aiScore: sql`excluded.ai_score`,
				scanId: sql`excluded.scan_id`
			}
		});
}

/**
 * Writes the moderation_actions side of a batch. Rescan mode both re-pends
 * action verdicts AND supersedes outstanding rows a fresh non-action verdict
 * replaces; live runs only ever see brand-new comments, so plain inserts.
 */
/** Rescan: the new verdict replaces whatever the row held — even a completed
 * or dispatched action returns to 'pending' so the fresh decision re-enforces.
 * The earlier outcome stays in the audit log (comment_id is the PK). */
async function upsertRescanActionRows(transaction: LedgerHandle, actions: ReturnType<typeof actionRows>): Promise<void> {
	if (!actions.length) return;
	await transaction
		.insert(moderationActions)
		.values(actions)
		.onConflictDoUpdate({
			target: moderationActions.commentId,
			set: {
				action: sql`excluded.action`,
				reason: sql`excluded.reason`,
				authorHandle: sql`excluded.author_handle`,
				state: 'pending',
				lastAttemptAt: null,
				lastManualRetryAt: null
			}
		});
}

/** A rescan verdict with NO action cancels the comment's outstanding intent —
 * a stale pending/dispatched row would otherwise be claimed by the next
 * enforcement sweep and apply the OLD decision on YouTube (codeant). Terminal
 * rows stay: they record actions that already reached YouTube, which no new
 * verdict can undo. 'pending' never reached YouTube — cancel outright. A
 * 'dispatched' call may already have landed remotely, so it goes 'cancelling'
 * and the next sweep supersedes it without retrying or changing remote state;
 * the owner can choose a new action from the queue or log. */
async function supersedeStaleActionRows(transaction: LedgerHandle, commentIds: string[]): Promise<void> {
	if (!commentIds.length) return;
	await transaction
		.update(moderationActions)
		.set({ state: 'superseded' })
		.where(
			and(
				inArray(moderationActions.commentId, commentIds),
				eq(moderationActions.state, 'pending')
			)
		);
	await transaction
		.update(moderationActions)
		.set({ state: 'cancelling' })
		.where(
			and(
				inArray(moderationActions.commentId, commentIds),
				eq(moderationActions.state, 'dispatched')
			)
		);
}

/**
 * Writes the moderation_actions side of a batch. Rescan mode both re-pends
 * action verdicts AND supersedes outstanding rows a fresh non-action verdict
 * replaces; live runs only ever see brand-new comments, so plain inserts.
 */
async function stageActionRows(
	transaction: LedgerHandle,
	decisions: Decision[],
	actions: ReturnType<typeof actionRows>,
	rescan: boolean
): Promise<void> {
	if (!rescan) {
		if (actions.length) await transaction.insert(moderationActions).values(actions);
		return;
	}
	await upsertRescanActionRows(transaction, actions);
	await supersedeStaleActionRows(
		transaction,
		decisions.filter((decision) => !decision.youtubeAction).map((decision) => decision.comment.id)
	);
}

/**
 * One credit per BILLABLE decision (AI budget was claimed for it), charged in
 * the SAME transaction as the staging: a crash rolls both back and a re-run
 * can never double-charge (the ledger's UNIQUE(org_id, ref_type, ref_id)
 * anchor is the backstop). Rule/allowlist decisions are never billed
 * (billable is set only where decide() decrements the AI budget).
 */
async function chargeBillableDecisions(
	transaction: LedgerHandle,
	orgId: string | null | undefined,
	decisions: Decision[],
	chargeScope: string | null | undefined
): Promise<void> {
	if (!orgId) return;
	const billable = decisions.filter((decision) => decision.billable);
	if (!billable.length) return;
	// A rescan charges again per comment: the anchor is scoped to the scan id
	// planted for THIS request, so each requested scan debits once while a
	// retry of the SAME scan hits the anchor and stages covered instead of
	// double-charging (I4). A null scope is a pre-nonce drain — its earlier
	// pages charged the plain comment id, so the anchor stays plain or the
	// retry double-charges (codex).
	const refIds = billable.map((decision) => commentChargeRef(decision.comment.id, chargeScope));
	// `metered` comes back read inside the charge transaction — a separate
	// orgIsMetered read could disagree with the charge under a concurrent
	// billing change (unmetered→metered stages free; metered→unmetered aborts
	// an unlimited run). Unmetered orgs (self-hosted, lifetime, pre-billing)
	// are unlimited: only a metered org's uncharged refs indicate a balance
	// exhausted concurrently with this run's AI budget read (codeant).
	const { uncharged, metered } = await consumeCreditsBulk(transaction, orgId, 'comment', refIds);
	if (metered && uncharged.length) {
		const failedIndex = refIds.indexOf(uncharged[0]);
		const failedDecision = billable[failedIndex];
		if (!failedDecision) throw new Error('bulk charge returned an unknown comment reference — staging aborted');
		// A shortfall must NEVER stage free: abort the staging transaction so
		// the comments stay unprocessed and retry after the org tops up.
		throw new Error(
			`credit charge failed for comment ${failedDecision.comment.id} (org ${orgId}) — staging aborted, balance exhausted concurrently`
		);
	}
}

/** Optional staging knobs: org to bill, channel identity for the liveness
 * assert, and rescan mode (upserts + scan-scoped charge anchors). */
export type StageOptions = { orgId?: string | null; expected?: ChannelIdentity; rescan?: RescanCharge; protectedIds?: string[] };

async function preserveRescanHumanClaims(transaction: LedgerHandle, channelId: string, decisions: Decision[], scanStamp?: string | null, protectedIds: string[] = []): Promise<Decision[]> {
	const candidateIds = [...new Set([...decisions.map(decision => decision.comment.id), ...protectedIds])];
	if (!candidateIds.length) return decisions;
	const existing = await transaction.select({ id: comments.id, status: comments.status, humanDispatchToken: comments.humanDispatchToken, humanDispatchState: comments.humanDispatchState })
		.from(comments).where(and(eq(comments.channelId, channelId), inArray(comments.id, candidateIds))).all();
	const reserved = existing.filter(hasHumanClaim).map(row => row.id);
	if (!reserved.length) return decisions;
	// The restoring claim owns intent before token refresh and reservation.
	// Record this scan's visit without changing that pending/active/uncertain
	// decision, its action rows, audit history, or credit balance.
	await transaction.update(comments).set({ scanId: scanStamp ?? null })
		.where(and(eq(comments.channelId, channelId), inArray(comments.id, reserved)));
	const reservedIds = new Set(reserved);
	console.warn('staging: preserved %d pending or reserved human decisions during history rescan', reserved.length);
	return decisions.filter(decision => !reservedIds.has(decision.comment.id));
}

type DecisionCounts = { acted: number; queued: number; stagedCount: number };
function decisionCounts(decisions: Decision[]): DecisionCounts {
	return {
		acted: decisions.filter(decision => decision.youtubeAction).length,
		queued: decisions.filter(decision => decision.auditAction === 'queue').length,
		stagedCount: decisions.length
	};
}

export async function stageDecisions(channelId: string, decisions: Decision[], options: StageOptions = {}) {
	if (!decisions.length && !(options.rescan && options.protectedIds?.length)) return decisionCounts(decisions);
	return await db.transaction(async (transaction) => {
		// The channel check and all staging writes share one transaction. Account
		// deletion either commits first (and this fails) or waits until these rows
		// are complete; no orphaned rows can be created between a preflight read
		// and the inserts.
		await assertChannelActive(channelId, transaction, options.expected);
		const handle = transaction as LedgerHandle;
		const committedDecisions = options.rescan
			? await preserveRescanHumanClaims(handle, channelId, decisions, options.rescan.scanStamp, options.protectedIds) : decisions;
		if (!committedDecisions.length) return decisionCounts(committedDecisions);
		if (options.rescan) {
			await upsertRescannedCommentRows(handle, channelId, committedDecisions, options.rescan.scanStamp);
		} else {
			await transaction.insert(comments).values(commentRows(channelId, committedDecisions));
		}
		await stageActionRows(handle, committedDecisions, actionRows(channelId, committedDecisions), options.rescan !== undefined);
		// Enforcement decisions (ban/reject/delete/hold) get their audit row at
		// completion from completeActions — EXCEPT a queued comment's 'queue'
		// row, which records WHY it waits for a human even though its 'hold'
		// row is written later by enforcement.
		const audits = auditRows(
			channelId,
			committedDecisions.filter((decision) => !decision.youtubeAction || decision.auditAction === 'queue'),
			false
		);
		if (audits.length) await transaction.insert(auditLog).values(audits);
		await chargeBillableDecisions(handle, options.orgId, committedDecisions, options.rescan?.chargeScope);
		return decisionCounts(committedDecisions);
	});
}


/**
 * Stages decisions (live) or writes the audit trail (dry run) once the
 * channel is confirmed still active. Returns counts from the committed batch.
 */
export async function stageOrAuditDecisions(
	channelId: string,
	decisions: Decision[],
	dryRun: boolean,
	options: StageOptions = {}
): Promise<DecisionCounts> {
	if (dryRun) {
		const audits = auditRows(channelId, decisions, true);
		if (audits.length) {
			await db.transaction(async (transaction) => {
				await assertChannelActive(channelId, transaction, options.expected);
				await transaction.insert(auditLog).values(audits);
			});
		}
		return decisionCounts(decisions);
	}
	return await stageDecisions(channelId, decisions, options);
}
