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
