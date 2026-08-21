// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; see LICENSE.

import { normalizeHandle } from '$lib/server/allowlist';
import { consumeCredit, orgIsMetered, type LedgerHandle } from '$lib/server/billing/ledger';
import { db } from '$lib/server/db';
import { auditLog, comments, moderationActions } from '$lib/server/db/schema';
import type { Decision } from './types';

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


export async function stageDecisions(channelId: string, decisions: Decision[], orgId?: string | null) {
	if (!decisions.length) return;
	const actions = actionRows(channelId, decisions);
	await db.transaction(async (transaction) => {
		await transaction.insert(comments).values(commentRows(channelId, decisions));
		if (actions.length) await transaction.insert(moderationActions).values(actions);
		const audits = auditRows(channelId, decisions.filter((decision) => !decision.youtubeAction), false);
		if (audits.length) await transaction.insert(auditLog).values(audits);
		// One credit per BILLABLE decision (AI budget was claimed for it), in
		// the SAME transaction as the staging: a crash rolls both back and a
		// re-run can never double-charge (the ledger's UNIQUE(org_id, ref_type,
		// ref_id) anchor is the backstop). Rule/allowlist decisions are never
		// billed (billable is set only where decide() decrements the AI
		// budget); a comment whose charge fails (balance hit 0 mid-batch)
		// stages free.
		if (orgId) {
			// Unmetered orgs (NULL balance — self-hosted, lifetime, pre-billing)
			// are unlimited: their consumeCredit attempts are DESIGNED no-ops
			// (the NULL-balance guard rejects the charge), so only a METERED
			// org's failed charge is an anomaly worth aborting for.
			const metered = await orgIsMetered(orgId);
			for (const decision of decisions) {
				if (!decision.billable) continue;
				const charged = await consumeCredit(transaction as LedgerHandle, orgId, decision.comment.id);
				if (!charged && metered) {
					// The balance was exhausted CONCURRENTLY (another run of the
					// same org spent the credits between this run's budget read
					// and the atomic charge). The decision must NEVER stage free:
					// abort the staging transaction — the rollback leaves the
					// comments unprocessed, so the next run re-fetches them once
					// the org tops up (codex review). Loud: the caller sees the
					// run fail and the cron answers 500.
					throw new Error(
						`credit charge failed for comment ${decision.comment.id} (org ${orgId}) — staging aborted, balance exhausted concurrently`
					);
				}
			}
		}
	});
}


/**
 * Stages decisions (live) or writes the audit trail (dry run) once the
 * channel is confirmed still active. Returns the acted count.
 */
export async function stageOrAuditDecisions(
	channelId: string,
	decisions: Decision[],
	dryRun: boolean,
	orgId: string | null | undefined
): Promise<number> {
	if (dryRun) {
		const acted = decisions.filter((decision) => decision.youtubeAction).length;
		const audits = auditRows(channelId, decisions, true);
		if (audits.length) await db.insert(auditLog).values(audits);
		return acted;
	}
	await stageDecisions(channelId, decisions, orgId);
	return decisions.filter((decision) => decision.youtubeAction).length;
}
