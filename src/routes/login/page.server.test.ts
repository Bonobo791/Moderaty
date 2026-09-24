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
