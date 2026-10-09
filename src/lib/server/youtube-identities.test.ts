import { afterEach, expect, test, vi } from 'vitest';
import { fetchAuthorHandles, resolveHandleChannelId } from './youtube';
afterEach(() => vi.unstubAllGlobals());

test('lookup failures retain provider diagnostics and HTTP status on the server', async () => {
	vi.stubGlobal('fetch', async () => new Response('synthetic-quota-diagnostic', {status:403}));
	try { await resolveHandleChannelId('handle', 'synthetic-token'); throw new Error('Expected lookup failure'); }
	catch (error) { expect(error).toMatchObject({httpStatus:403}); expect((error as Error).message).toContain('synthetic-quota-diagnostic'); }
});

test('ordinary commenter handles come only from authoritative channel snippets in batches of fifty', async () => {
	const ids = Array.from({length:51}, (_, index) => `author-${index}`);
	const calls: string[][] = [];
	vi.stubGlobal('fetch', async (input: string | URL) => {
		const url = new URL(String(input));
		expect(url.pathname).toBe('/youtube/v3/channels');
		expect(url.searchParams.get('part')).toBe('snippet');
		const batch = url.searchParams.get('id')!.split(','); calls.push(batch);
		return Response.json({items:batch.map(id => ({id, snippet:{title:'Impersonating Display Name', customUrl: id === 'author-0' ? 'legacy-url' : '@Handle_' + id.split('-')[1]}}))});
	});
	const result = await fetchAuthorHandles(ids, 'synthetic-token');
	expect(calls.map(batch => batch.length)).toEqual([50,1]);
	expect(result.get('author-50')).toBe('handle_50');
	expect(result.has('author-0')).toBe(false);
	expect([...result.values()]).not.toContain('Impersonating Display Name');
});
