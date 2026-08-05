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

import { expect, test } from 'vitest';

import { makeCookies, makeCookiesWithState } from './testcookies';

test('a fresh jar returns undefined for a name that was never set', () => {
	const cookies = makeCookies();

	expect(cookies.get('missing')).toBeUndefined();
	expect(cookies.setCalls).toEqual([]);
	expect(cookies.deleteCalls).toEqual([]);
});

test('set records the exact call and makes the value retrievable', () => {
	const cookies = makeCookies();
	const opts = { path: '/', httpOnly: true };

	cookies.set('session', 'token-123', opts);

	expect(cookies.setCalls).toEqual([{ name: 'session', value: 'token-123', opts }]);
	expect(cookies.get('session')).toBe('token-123');
	expect(cookies.deleteCalls).toEqual([]);
});

test('set overwrites a previous value and keeps both recorded calls', () => {
	const cookies = makeCookies();

	cookies.set('a', 'first', { path: '/' });
	cookies.set('a', 'second', { path: '/' });

	expect(cookies.get('a')).toBe('second');
	expect(cookies.setCalls).toEqual([
		{ name: 'a', value: 'first', opts: { path: '/' } },
		{ name: 'a', value: 'second', opts: { path: '/' } }
	]);
});

test('delete records the call with its opts and removes the value', () => {
	const cookies = makeCookies();
	cookies.set('session', 'token-123', { path: '/' });

	cookies.delete('session', { path: '/' });

	expect(cookies.deleteCalls).toEqual([{ name: 'session', opts: { path: '/' } }]);
	expect(cookies.get('session')).toBeUndefined();
});

test('delete without opts records undefined opts, like SvelteKit passes it', () => {
	const cookies = makeCookies();

	cookies.delete('orphan');

	expect(cookies.deleteCalls).toEqual([{ name: 'orphan', opts: undefined }]);
});

test('two jars do not share storage or call records', () => {
	const a = makeCookies();
	const b = makeCookies();

	a.set('x', 'in-a', { path: '/' });

	expect(b.get('x')).toBeUndefined();
	expect(b.setCalls).toEqual([]);
});

test('makeCookiesWithState seeds the pending states JSON under oauth_state', () => {
	const cookies = makeCookiesWithState('state-1', 'state-2');

	expect(cookies.get('oauth_state')).toBe(JSON.stringify(['state-1', 'state-2']));
	expect(cookies.setCalls).toEqual([
		{ name: 'oauth_state', value: JSON.stringify(['state-1', 'state-2']), opts: { path: '/' } }
	]);
});

test('makeCookiesWithState with no states seeds an empty JSON array', () => {
	const cookies = makeCookiesWithState();

	expect(cookies.get('oauth_state')).toBe('[]');
});
