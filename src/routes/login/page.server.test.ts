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

import { expect, test } from 'vitest';

import { load } from './+page.server';

function ctx(user: unknown) {
	return { locals: { user } } as never;
}

test('load: signed-in user is redirected to the dashboard (302)', () => {
	let caught: unknown;
	try {
		load(ctx({ id: 'user-1' }));
	} catch (e) {
		caught = e;
	}
	expect(caught).toMatchObject({ status: 302, location: '/dashboard' });
});

test('load: signed-out visitor gets the empty payload (no redirect)', async () => {
	const data = (await load(ctx(null))) as Record<string, never>;
	expect(data).toEqual({});
});
