import { expect, test, vi } from 'vitest';

const mockRunChannel = vi.hoisted(() => vi.fn());
vi.mock('./pipeline/run', () => ({ runChannel: mockRunChannel }));

import { runChannel } from './pipeline';

test('keeps the public pipeline facade wired to the orchestrator', () => {
	expect(runChannel).toBe(mockRunChannel);
});
