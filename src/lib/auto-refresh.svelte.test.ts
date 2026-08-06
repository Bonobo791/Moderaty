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

import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('$app/navigation', () => ({
	invalidateAll: vi.fn()
}));

import { invalidateAll } from '$app/navigation';
import { autoRefresh } from './auto-refresh.svelte';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// vitest compiles .svelte.ts for SSR, where $effect is a no-op, so the client
// behavior (interval + invalidateAll + cleanup) cannot be exercised in this
// harness — that is why stryker.config.json excludes this file from the
// mutate scope. What CAN be pinned here is the SSR contract: calling
// autoRefresh during server rendering must not schedule work or throw.
test('schedules no refresh work while rendering on the server', () => {
	vi.useFakeTimers();
	const destroy = $effect.root(() => {
		autoRefresh(1_000);
	});
	flushSync();

	vi.advanceTimersByTime(60_000);

	expect(invalidateAll).not.toHaveBeenCalled();
	destroy();
});
