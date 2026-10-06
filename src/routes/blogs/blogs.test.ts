import { render } from 'svelte/server';
import { expect, test } from 'vitest';

const path = '/blogs/how-to-deal-with-hate-comments-on-youtube/';
const title = 'How to deal with hate comments on YouTube';

test('the article renders its decision table, precise controls, and fictional-example labels', async () => {
	const Article = (await import('./how-to-deal-with-hate-comments-on-youtube/+page.svelte')).default;
	const { body, head } = render(Article);
	for (const text of ['These invented examples', 'None comes from a real viewer or creator.', 'Community', 'Published', 'Remove', 'Hide from channel', 'one free moderation dry run', 'Deleted comments cannot be restored']) {
		expect(body).toContain(text);
	}
	expect(body).toMatch(/<caption[^>]*>/);
	expect(body.match(/scope="row"/g)).toHaveLength(5);
	expect(body.match(/scope="col"/g)).toHaveLength(3);
	expect(body).not.toMatch(/Editorial review notes|Draft for Andrew|MC-1|custom preview upload/i);
	expect(head).toContain(`<title>${title} | Moderaty</title>`);
	expect(head).toContain(`rel="canonical" href="https://moderaty.com${path}"`);
	const data = JSON.parse(head.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]);
	expect(data).toMatchObject({ '@type': 'BlogPosting', headline: title, url: `https://moderaty.com${path}`, inLanguage: 'en' });
	for (const field of ['author', 'datePublished', 'dateModified', 'reviewedBy', 'lastReviewed']) expect(data).not.toHaveProperty(field);
});

test('the index links to the single owning route', async () => {
	const Index = (await import('./+page.svelte')).default;
	const { body, head } = render(Index);
	expect(body).toContain(`href="${path}"`);
	expect(body).toContain(title);
	expect(body.match(/<h2/g)).toHaveLength(1);
	expect(head).toContain('rel="canonical" href="https://moderaty.com/blogs/"');
	expect(body).not.toContain('/guides/');
});
