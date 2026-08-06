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

function expectIndex(table: SQLiteTable, name: string, columns: string[]): void {
	const config = getTableConfig(table);
	const found = config.indexes.find((i) => i.config.name === name);
	expect(found, `${config.name} index ${name}`).toBeDefined();
	expect(found!.config.columns.map((c) => (c as { name: string }).name)).toEqual(columns);
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
			created_at: { notNull: true, hasDefault: true }
		});
		expectCreatedAtDefault(organizations);
	});

	test('personal_for is unique and plan defaults to free', async () => {
		const { organizations } = await loadSchema();
		expectUnique(organizations, 'personal_for', 'organizations_personal_for_unique');
		expect(getTableConfig(organizations).columns.find((c) => c.name === 'plan')!.default).toBe('free');
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
			created_at: { notNull: true, hasDefault: true }
		});
		expectIndex(auditLog, 'audit_log_channel_action_idx', ['channel_id', 'action']);
		expectCreatedAtDefault(auditLog);
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
