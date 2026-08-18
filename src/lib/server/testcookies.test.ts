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
