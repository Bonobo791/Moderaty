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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const state = {
		// Rows as the DB would return them pre-projection: legacy non-null
		// author identifiers still present.
		rows: [] as Record<string, unknown>[],
		selectArgs: [] as unknown[]
	};
	// Emulate drizzle: an explicit projection maps each row to the selected
	// keys; a bare .select() returns full rows (author columns included).
	const project = (row: Record<string, unknown>, projection: Record<string, unknown> | undefined) => {
		if (!projection) return row;
		return Object.fromEntries(Object.keys(projection).map((key) => [key, row[key]]));
	};
	const db = {
		select: vi.fn((...args: unknown[]) => {
			state.selectArgs = args;
			const projection = args[0] as Record<string, unknown> | undefined;
			return {
				from: () => ({
					where: () => ({
						orderBy: () => ({
							limit: () => ({
								all: async () => state.rows.map((row) => project(row, projection))
							})
						})
					})
				})
			};
		})
	};
	return { state, db, ownedChannel: vi.fn() };
});

vi.mock('$lib/server/db', () => ({ db: mocks.db }));
vi.mock('$lib/server/ownership', () => ({ ownedChannel: mocks.ownedChannel }));
vi.mock('$lib/server/youtube', () => ({
	refreshAccessToken: vi.fn(),
	setModerationStatus: vi.fn(),
	deleteComment: vi.fn()
}));
vi.mock('$lib/server/crypto', () => ({ decrypt: vi.fn() }));
vi.mock('$lib/server/session', () => ({ requireUser: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { load } from './+page.server';

// PR #40 review: a bare .select() returns full comment rows, leaking any
// legacy non-null author identifiers to the browser. The load must project
// only what the page renders (id, text, publishedAt) — never author columns.
describe('queue load projection (behavior)', () => {
	beforeEach(() => {
		mocks.state.rows = [
			{
				id: 'comment-1',
				text: 'first held comment',
				publishedAt: '2026-01-01T00:00:00.000Z',
				authorName: 'Legacy Author',
				authorChannelId: 'UClegacy1'
			},
			{
				id: 'comment-2',
				text: 'second held comment',
				publishedAt: '2026-01-02T00:00:00.000Z',
				authorName: 'Another Author',
				authorChannelId: 'UClegacy2'
			}
		];
		mocks.ownedChannel.mockResolvedValue({ id: 'UCchan', title: 'My channel', refreshTokenEnc: 'enc' });
	});

	const event = () =>
		({ params: { id: 'UCchan' }, locals: { user: { id: 'user-1' } } }) as unknown as Parameters<typeof load>[0];

	it('returns the maintenance payload during a database outage instead of throwing', async () => {
		const result = await load({
			params: { id: 'UCchan' },
			locals: { user: null, dbDown: true }
		} as unknown as Parameters<typeof load>[0]);

		expect(result).toEqual({ ch: { id: 'UCchan', title: '' }, pending: [], maintenance: true });
		// The outage short-circuit runs before any ownership or DB work.
		expect(mocks.ownedChannel).not.toHaveBeenCalled();
	});

	it('returns only the projected fields — never author identifiers', async () => {
		const result = await load(event());

		expect(mocks.ownedChannel).toHaveBeenCalledWith('UCchan', expect.anything());
		expect(result.ch).toEqual({ id: 'UCchan', title: 'My channel' });
		expect(result.pending).toHaveLength(2);
		expect(result.pending.map((row) => row.id)).toEqual(['comment-1', 'comment-2']);
		for (const row of result.pending) {
			expect(Object.keys(row).sort()).toEqual(['id', 'publishedAt', 'text']);
			expect(row).not.toHaveProperty('authorName');
			expect(row).not.toHaveProperty('authorChannelId');
		}
	});

	it('queries with an explicit field projection, not a bare .select()', async () => {
		await load(event());

		expect(mocks.state.selectArgs).toHaveLength(1);
		expect(Object.keys(mocks.state.selectArgs[0] as Record<string, unknown>).sort()).toEqual([
			'id',
			'publishedAt',
			'text'
		]);
	});
});
