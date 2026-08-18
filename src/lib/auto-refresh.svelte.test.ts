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
