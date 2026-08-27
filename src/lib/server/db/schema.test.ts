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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

import { SQL } from 'drizzle-orm';
import { SQLiteSyncDialect, getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, test, vi } from 'vitest';

// Behavior test for the Drizzle schema itself: a mutated table/column name,
// dropped constraint, or flipped default must fail here — the schema is the
// contract every query and migration relies on. Asserts through drizzle's
// table metadata (getTableConfig), not snapshots, so every expectation is an
// explicit, hand-written value.
//
// The schema module is re-imported per test (vi.resetModules + dynamic
// import, the idiom from index.test.ts) so each test executes the module
// top-level itself — Stryker's perTest coverage attributes module-scope
// mutants only to tests that run the module body, and a static import would
// attribute every mutant to whichever test happened to load the module first.

type Schema = typeof import('./schema');

async function loadSchema(): Promise<Schema> {
	vi.resetModules();
	return await import('./schema');
}

const dialect = new SQLiteSyncDialect();

function sqlText(fragment: unknown): string {
	expect(fragment).toBeInstanceOf(SQL);
	return dialect.sqlToQuery(fragment as SQL).sql;
}

interface ColumnShape {
	notNull: boolean;
	hasDefault?: boolean;
	primary?: boolean;
	autoIncrement?: boolean;
}

function expectColumns(table: SQLiteTable, expected: Record<string, ColumnShape>): void {
	const config = getTableConfig(table);
	expect(config.columns.map((c) => c.name)).toEqual(Object.keys(expected));
	for (const column of config.columns) {
		const shape = expected[column.name];
		expect(shape, `unexpected column ${config.name}.${column.name}`).toBeDefined();
		expect(column.notNull, `${config.name}.${column.name} notNull`).toBe(shape.notNull);
		expect(column.primary, `${config.name}.${column.name} primary`).toBe(shape.primary ?? false);
		if (shape.hasDefault !== undefined)
			expect(column.hasDefault, `${config.name}.${column.name} hasDefault`).toBe(shape.hasDefault);
		if (shape.autoIncrement !== undefined)
			expect(
				(column as { autoIncrement?: boolean }).autoIncrement,
				`${config.name}.${column.name} autoIncrement`
			).toBe(shape.autoIncrement);
	}
}

function expectCreatedAtDefault(table: SQLiteTable): void {
	const config = getTableConfig(table);
	const createdAt = config.columns.find((c) => c.name === 'created_at');
	expect(createdAt, `${config.name} created_at column`).toBeDefined();
	expect(createdAt!.notNull).toBe(true);
	expect(sqlText(createdAt!.default)).toBe(`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);
}

function expectIndex(table: SQLiteTable, name: string, columns: string[], expected: { unique?: boolean; where?: string } = {}): void {
	const config = getTableConfig(table);
	const found = config.indexes.find((i) => i.config.name === name);
	expect(found, `${config.name} index ${name}`).toBeDefined();
	expect(found!.config.columns.map((c) => (c as { name: string }).name)).toEqual(columns);
	expect(found!.config.unique, `${config.name} index ${name} unique`).toBe(expected.unique ?? false);
	const where = found!.config.where;
	if (expected.where === undefined) expect(where, `${config.name} index ${name} where`).toBeUndefined();
	else expect(sqlText(where), `${config.name} index ${name} where`).toBe(expected.where);
}

function expectForeignKey(
	table: SQLiteTable,
	column: string,
	foreignTable: SQLiteTable,
	foreignColumn: string,
	onDelete?: string
): void {
	const config = getTableConfig(table);
	const foreignName = getTableConfig(foreignTable).name;
	const fk = config.foreignKeys.find((f) => {
		const ref = f.reference();
		return (
			ref.columns.some((c) => c.name === column) &&
			getTableConfig(ref.foreignTable).name === foreignName &&
			ref.foreignColumns.some((c) => c.name === foreignColumn)
		);
	});
	expect(fk, `${config.name} FK ${column} -> ${foreignName}.${foreignColumn}`).toBeDefined();
	if (onDelete !== undefined) expect(fk!.onDelete).toBe(onDelete);
}

function expectUnique(table: SQLiteTable, columnName: string, constraintName: string): void {
	const config = getTableConfig(table);
	const column = config.columns.find((c) => c.name === columnName)! as unknown as {
		isUnique: boolean;
		uniqueName: string;
	};
	expect(column.isUnique, `${config.name}.${columnName} isUnique`).toBe(true);
	expect(column.uniqueName, `${config.name}.${columnName} uniqueName`).toBe(constraintName);
}

describe('users', () => {
	test('table shape', async () => {
		const { users } = await loadSchema();
		expect(getTableConfig(users).name).toBe('users');
		expectColumns(users, {
			id: { notNull: true, primary: true },
			google_sub: { notNull: true },
			email: { notNull: true },
			display_name: { notNull: true },
			plan: { notNull: true, hasDefault: true },
			created_at: { notNull: true, hasDefault: true }
		});
	});

	test('google_sub is unique and plan defaults to free', async () => {
		const { users } = await loadSchema();
		expectUnique(users, 'google_sub', 'users_google_sub_unique');
		expect(getTableConfig(users).columns.find((c) => c.name === 'plan')!.default).toBe('free');
	});

	test('created_at default is the UTC strftime expression', async () => {
		const { users } = await loadSchema();
		expectCreatedAtDefault(users);
	});
});

describe('sessions', () => {
	test('table shape', async () => {
		const { sessions } = await loadSchema();
		expect(getTableConfig(sessions).name).toBe('sessions');
		expectColumns(sessions, {
			id: { notNull: true, primary: true },
			user_id: { notNull: true },
			active_org_id: { notNull: false },
			expires_at: { notNull: true },
			created_at: { notNull: true, hasDefault: true }
		});
		expectCreatedAtDefault(sessions);
	});

	test('user_id cascades to users.id and is indexed', async () => {
		const { sessions, users } = await loadSchema();
		expectForeignKey(sessions, 'user_id', users, 'id', 'cascade');
		expectIndex(sessions, 'sessions_user_id_idx', ['user_id']);
	});
});

describe('organizations', () => {
	test('table shape', async () => {
		const { organizations } = await loadSchema();
		expect(getTableConfig(organizations).name).toBe('organizations');
		expectColumns(organizations, {
			id: { notNull: true, primary: true },
			name: { notNull: true },
			plan: { notNull: true, hasDefault: true },
			personal_for: { notNull: false },
			openai_key_enc: { notNull: false },
			credits_remaining: { notNull: false },
			stripe_customer_id: { notNull: false },
			stripe_default_pm_id: { notNull: false },
			auto_topup_enabled: { notNull: false },
			auto_topup_threshold: { notNull: false },
			auto_topup_state: { notNull: false },
			auto_topup_last_attempt_at: { notNull: false },
			auto_topup_failures: { notNull: false },
			auto_topup_consent_text: { notNull: false },
			auto_topup_consent_version: { notNull: false },
			auto_topup_consented_by: { notNull: false },
			auto_topup_consented_at: { notNull: false },
			stripe_subscription_id: { notNull: false },
			stripe_subscription_status: { notNull: false },
			stripe_subscription_period_start: { notNull: false },
			stripe_subscription_period_end: { notNull: false },
			stripe_subscription_cancel_at_period_end: { notNull: false },
			stripe_subscription_last_event_created: { notNull: false },
			stripe_subscription_last_event_id: { notNull: false },
			stripe_customer_last_event_created: { notNull: false },
			stripe_customer_last_event_id: { notNull: false },
			created_at: { notNull: true, hasDefault: true }
		});
		expectCreatedAtDefault(organizations);
	});

	test('personal_for is unique and plan defaults to free', async () => {
		const { organizations } = await loadSchema();
		expectUnique(organizations, 'personal_for', 'organizations_personal_for_unique');
		expectIndex(organizations, 'organizations_stripe_customer_id_unique', ['stripe_customer_id'], { unique: true, where: '"organizations"."stripe_customer_id" IS NOT NULL' });
		expectIndex(organizations, 'organizations_stripe_subscription_id_unique', ['stripe_subscription_id'], { unique: true, where: '"organizations"."stripe_subscription_id" IS NOT NULL' });
		expect(getTableConfig(organizations).columns.find((c) => c.name === 'plan')!.default).toBe('free');
	});
});



describe('stripeSubscriptionPeriods', () => {
	test('table shape and period uniqueness', async () => {
		const { stripeSubscriptionPeriods, organizations } = await loadSchema();
		expect(getTableConfig(stripeSubscriptionPeriods).name).toBe('stripe_subscription_periods');
		expectColumns(stripeSubscriptionPeriods, {
			id: { notNull: true, primary: true, autoIncrement: true },
			org_id: { notNull: true },
			subscription_id: { notNull: true },
			invoice_id: { notNull: true },
			payment_intent_id: { notNull: false },
			charge_id: { notNull: false },
			period_key: { notNull: true },
			period_start: { notNull: true },
			period_end: { notNull: true },
			included_credits: { notNull: true, hasDefault: true },
			consumed_credits: { notNull: true, hasDefault: true },
			status: { notNull: true, hasDefault: true },
			created_at: { notNull: true, hasDefault: true }
		});
		expectForeignKey(stripeSubscriptionPeriods, 'org_id', organizations, 'id', 'cascade');
		expectUnique(stripeSubscriptionPeriods, 'invoice_id', 'stripe_subscription_periods_invoice_id_unique');
		expectIndex(stripeSubscriptionPeriods, 'stripe_subscription_periods_subscription_period_unique', ['subscription_id', 'period_key'], { unique: true });
	});
});

describe('stripeLifetimeSlots', () => {
	test('table shape and slot key', async () => {
		const { stripeLifetimeSlots, organizations } = await loadSchema();
		expect(getTableConfig(stripeLifetimeSlots).name).toBe('stripe_lifetime_slots');
		expectColumns(stripeLifetimeSlots, {
			slot: { notNull: true, primary: true },
			active_org_id: { notNull: false },
			active_entitlement_id: { notNull: false },
			claimed_at: { notNull: false },
			released_at: { notNull: false }
		});
		expectForeignKey(stripeLifetimeSlots, 'active_org_id', organizations, 'id', 'set null');
	});
});

describe('stripeLifetimeEntitlements', () => {
	test('table shape, active uniqueness, and payment indexes', async () => {
		const { stripeLifetimeEntitlements, stripeLifetimeSlots, organizations } = await loadSchema();
		expect(getTableConfig(stripeLifetimeEntitlements).name).toBe('stripe_lifetime_entitlements');
		expectColumns(stripeLifetimeEntitlements, {
			id: { notNull: true, primary: true, autoIncrement: true },
			org_id: { notNull: true },
			slot: { notNull: true },
			checkout_session_id: { notNull: true },
			payment_intent_id: { notNull: false },
			charge_id: { notNull: false },
			status: { notNull: true, hasDefault: true },
			created_at: { notNull: true, hasDefault: true },
			released_at: { notNull: false }
		});
		expectForeignKey(stripeLifetimeEntitlements, 'org_id', organizations, 'id', 'cascade');
		expectForeignKey(stripeLifetimeEntitlements, 'slot', stripeLifetimeSlots, 'slot');
		expectUnique(stripeLifetimeEntitlements, 'checkout_session_id', 'stripe_lifetime_entitlements_checkout_session_id_unique');
		expectIndex(stripeLifetimeEntitlements, 'stripe_lifetime_entitlements_payment_intent_idx', ['payment_intent_id']);
		expectIndex(stripeLifetimeEntitlements, 'stripe_lifetime_entitlements_charge_idx', ['charge_id']);
		expectIndex(stripeLifetimeEntitlements, 'stripe_lifetime_entitlements_active_org_idx', ['org_id'], { unique: true, where: `"stripe_lifetime_entitlements"."status" = 'active'` });
		expectIndex(stripeLifetimeEntitlements, 'stripe_lifetime_entitlements_active_slot_idx', ['slot'], { unique: true, where: `"stripe_lifetime_entitlements"."status" = 'active'` });
	});
});

describe('stripeCheckoutAttempts', () => {
	test('durable attempt identity and Stripe session uniqueness', async () => {
		const { stripeCheckoutAttempts, organizations } = await loadSchema();
		expect(getTableConfig(stripeCheckoutAttempts).name).toBe('stripe_checkout_attempts');
		expectColumns(stripeCheckoutAttempts, {
			id: { notNull: true, primary: true, autoIncrement: true },
			attempt_id: { notNull: true },
			org_id: { notNull: true },
			product: { notNull: true },
			idempotency_key: { notNull: true },
			stripe_session_id: { notNull: false },
			status: { notNull: true, hasDefault: true },
			created_at: { notNull: true, hasDefault: true },
			updated_at: { notNull: true, hasDefault: true }
		});
		expectForeignKey(stripeCheckoutAttempts, 'org_id', organizations, 'id', 'cascade');
		expectUnique(stripeCheckoutAttempts, 'attempt_id', 'stripe_checkout_attempts_attempt_id_unique');
		expectUnique(stripeCheckoutAttempts, 'idempotency_key', 'stripe_checkout_attempts_idempotency_key_unique');
		expectUnique(stripeCheckoutAttempts, 'stripe_session_id', 'stripe_checkout_attempts_stripe_session_id_unique');
		expectIndex(stripeCheckoutAttempts, 'stripe_checkout_attempts_org_status_idx', ['org_id', 'status']);
	});
});

describe('memberships', () => {
	test('composite primary key and cascading FKs', async () => {
		const { memberships, users, organizations } = await loadSchema();
		expect(getTableConfig(memberships).name).toBe('memberships');
		expectColumns(memberships, {
			user_id: { notNull: true },
			org_id: { notNull: true },
			role: { notNull: true },
			created_at: { notNull: true, hasDefault: true }
		});
		const pk = getTableConfig(memberships).primaryKeys;
		expect(pk).toHaveLength(1);
		expect(pk[0].columns.map((c) => c.name)).toEqual(['user_id', 'org_id']);
		expectForeignKey(memberships, 'user_id', users, 'id', 'cascade');
		expectForeignKey(memberships, 'org_id', organizations, 'id', 'cascade');
		expectIndex(memberships, 'memberships_org_id_idx', ['org_id']);
		expectCreatedAtDefault(memberships);
	});
});

describe('invites', () => {
	test('table shape and FKs', async () => {
		const { invites, users, organizations } = await loadSchema();
		expect(getTableConfig(invites).name).toBe('invites');
		expectColumns(invites, {
			token: { notNull: true, primary: true },
			org_id: { notNull: true },
			role: { notNull: true },
			created_by: { notNull: true },
			expires_at: { notNull: true },
			accepted_by: { notNull: false },
			created_at: { notNull: true, hasDefault: true }
		});
		expectForeignKey(invites, 'org_id', organizations, 'id', 'cascade');
		expectForeignKey(invites, 'created_by', users, 'id');
		expectIndex(invites, 'invites_org_id_idx', ['org_id']);
		expectCreatedAtDefault(invites);
	});
});

describe('channels', () => {
	test('table shape', async () => {
		const { channels } = await loadSchema();
		expect(getTableConfig(channels).name).toBe('channels');
		expectColumns(channels, {
			id: { notNull: true, primary: true },
			user_id: { notNull: false },
			org_id: { notNull: false },
			title: { notNull: true },
			refresh_token_enc: { notNull: true },
			cursor: { notNull: false },
			next_page_token: { notNull: false },
			scan_cursor: { notNull: false },
			history_next_page_token: { notNull: false },
			history_boundary: { notNull: false },
			dry_run_boundary: { notNull: false },
			dry_run_page_token: { notNull: false },
			last_run_at: { notNull: false },
			lease_expires_at: { notNull: false },
			active: { notNull: true, hasDefault: true },
			tone_level: { notNull: false },
			protect_lgbtqia: { notNull: true, hasDefault: true },
			protect_women: { notNull: true, hasDefault: true },
			created_at: { notNull: true, hasDefault: true }
		});
		expectCreatedAtDefault(channels);
	});

	test('flag defaults', async () => {
		const { channels } = await loadSchema();
		const config = getTableConfig(channels);
		expect(config.columns.find((c) => c.name === 'active')!.default).toBe(1);
		expect(config.columns.find((c) => c.name === 'protect_lgbtqia')!.default).toBe(0);
		expect(config.columns.find((c) => c.name === 'protect_women')!.default).toBe(0);
	});

	test('indexes and tenancy check', async () => {
		const { channels } = await loadSchema();
		expectIndex(channels, 'channels_user_id_idx', ['user_id']);
		expectIndex(channels, 'channels_org_id_idx', ['org_id']);
		const config = getTableConfig(channels);
		const check = config.checks.find((c) => c.name === 'channels_org_requires_owner');
		expect(check, 'tenancy check constraint').toBeDefined();
		expect(sqlText(check!.value)).toBe('"channels"."org_id" IS NOT NULL OR "channels"."user_id" IS NULL');
	});
});

describe('rules', () => {
	test('table shape with autoincrement id', async () => {
		const { rules } = await loadSchema();
		expect(getTableConfig(rules).name).toBe('rules');
		expectColumns(rules, {
			id: { notNull: true, primary: true, autoIncrement: true },
			channel_id: { notNull: true },
			type: { notNull: true },
			pattern: { notNull: true },
			action: { notNull: true },
			created_at: { notNull: true, hasDefault: true }
		});
		expectCreatedAtDefault(rules);
	});
});

describe('comments', () => {
	test('table shape', async () => {
		const { comments } = await loadSchema();
		expect(getTableConfig(comments).name).toBe('comments');
		expectColumns(comments, {
			id: { notNull: true, primary: true },
			channel_id: { notNull: true },
			author_channel_id: { notNull: false },
			author_name: { notNull: false },
			text: { notNull: true },
			published_at: { notNull: true },
			status: { notNull: true },
			decided_by: { notNull: true },
			matched_rule_id: { notNull: false },
			ai_score: { notNull: false },
			created_at: { notNull: true, hasDefault: true }
		});
		expectCreatedAtDefault(comments);
	});
});

describe('moderation_actions', () => {
	test('table shape and composite state index', async () => {
		const { moderationActions } = await loadSchema();
		expect(getTableConfig(moderationActions).name).toBe('moderation_actions');
		expectColumns(moderationActions, {
			comment_id: { notNull: true, primary: true },
			channel_id: { notNull: true },
			action: { notNull: true },
			reason: { notNull: true },
			state: { notNull: true },
			last_attempt_at: { notNull: false },
			last_manual_retry_at: { notNull: false },
			author_handle: { notNull: false },
			created_at: { notNull: true, hasDefault: true }
		});
		expectIndex(moderationActions, 'moderation_actions_channel_state_idx', ['channel_id', 'state']);
		expectCreatedAtDefault(moderationActions);
	});
});

describe('audit_log', () => {
	test('table shape with autoincrement id and composite index', async () => {
		const { auditLog } = await loadSchema();
		expect(getTableConfig(auditLog).name).toBe('audit_log');
		expectColumns(auditLog, {
			id: { notNull: true, primary: true, autoIncrement: true },
			channel_id: { notNull: true },
			comment_id: { notNull: true },
			action: { notNull: true },
			reason: { notNull: true },
			actor: { notNull: true },
			text: { notNull: false },
			author_handle: { notNull: false },
			created_at: { notNull: true, hasDefault: true }
		});
		expectIndex(auditLog, 'audit_log_channel_action_idx', ['channel_id', 'action']);
		expectCreatedAtDefault(auditLog);
	});
});

describe('channel_allowed_handles', () => {
	test('table shape with autoincrement id and channel index, no FKs', async () => {
		const { channelAllowedHandles } = await loadSchema();
		expect(getTableConfig(channelAllowedHandles).name).toBe('channel_allowed_handles');
		expectColumns(channelAllowedHandles, {
			id: { notNull: true, primary: true, autoIncrement: true },
			channel_id: { notNull: true },
			handle: { notNull: true },
			created_at: { notNull: true, hasDefault: true }
		});
		// Channel-child tables deliberately carry no .references() — orphan
		// protection is deletion.ts + the verify-tenancy probe.
		expect(getTableConfig(channelAllowedHandles).foreignKeys).toEqual([]);
		expectIndex(channelAllowedHandles, 'channel_allowed_handles_channel_idx', ['channel_id']);
		expectCreatedAtDefault(channelAllowedHandles);
	});
});

describe('consents', () => {
	test('table shape', async () => {
		const { consents } = await loadSchema();
		expect(getTableConfig(consents).name).toBe('consents');
		expectColumns(consents, {
			id: { notNull: true, primary: true, autoIncrement: true },
			user_id: { notNull: true },
			email: { notNull: false },
			doc_version: { notNull: true },
			checkbox_text: { notNull: true },
			ip: { notNull: true },
			user_agent: { notNull: true },
			marketing_opt_in: { notNull: true, hasDefault: true },
			created_at: { notNull: true, hasDefault: true }
		});
		expect(getTableConfig(consents).columns.find((c) => c.name === 'marketing_opt_in')!.default).toBe(0);
		expectCreatedAtDefault(consents);
	});

	test('user FK cascades; retention sweep index is partial on email', async () => {
		const { consents, users } = await loadSchema();
		expectForeignKey(consents, 'user_id', users, 'id', 'cascade');
		expectIndex(consents, 'consents_user_id_idx', ['user_id']);
		const config = getTableConfig(consents);
		const retention = config.indexes.find((i) => i.config.name === 'consents_email_retention_idx');
		expect(retention, 'retention index').toBeDefined();
		expect(retention!.config.columns.map((c) => (c as { name: string }).name)).toEqual(['created_at']);
		expect(sqlText(retention!.config.where)).toBe('"consents"."email" is not null');
	});
});

describe('contact_submissions', () => {
	test('table shape with unique verification token and status+email index', async () => {
		const { contactSubmissions } = await loadSchema();
		expect(getTableConfig(contactSubmissions).name).toBe('contact_submissions');
		expectColumns(contactSubmissions, {
			id: { notNull: true, primary: true, autoIncrement: true },
			email: { notNull: true },
			name: { notNull: true },
			status: { notNull: true, hasDefault: true },
			verification_token: { notNull: true },
			expires_at: { notNull: true },
			verified_at: { notNull: false },
			consent_text: { notNull: true },
			ip: { notNull: true },
			user_agent: { notNull: true },
			created_at: { notNull: true, hasDefault: true }
		});
		expectUnique(contactSubmissions, 'verification_token', 'contact_submissions_verification_token_unique');
		expect(getTableConfig(contactSubmissions).columns.find((c) => c.name === 'status')!.default).toBe('pending');
		expectIndex(contactSubmissions, 'contact_submissions_status_email_idx', ['status', 'email']);
		expectCreatedAtDefault(contactSubmissions);
	});
});
