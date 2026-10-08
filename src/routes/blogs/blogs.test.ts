import { render } from 'svelte/server';
import { expect, test } from 'vitest';

const path = '/blogs/how-to-deal-with-hate-comments-on-youtube/';
const title = 'How to deal with hate comments on YouTube';
const pageData = { locale: 'en' as const, siteOrigin: 'https://moderaty.com' };

test('the article renders its decision table, precise controls, and fictional-example labels', async () => {
	const Article = (await import('./how-to-deal-with-hate-comments-on-youtube/+page.svelte')).default;
	const { body, head } = render(Article, { props: { data: pageData } });
	for (const text of ['These fictional examples', 'They are not quotes from real viewers.', 'YouTube Studio', 'Remove', 'Hide from channel', 'free moderation dry run', 'Deleted comments cannot be restored']) {
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
	expect(data.author).toEqual({ '@type': 'Organization', name: 'Moderaty', url: 'https://moderaty.com/' });
	for (const field of ['datePublished', 'dateModified', 'reviewedBy', 'lastReviewed']) expect(data).not.toHaveProperty(field);
});

test('the index links to both owning article routes', async () => {
	const Index = (await import('./+page.svelte')).default;
	const { body, head } = render(Index, { props: { data: pageData } });
	expect(body).toContain(`href="${path}"`);
	expect(body).toContain(title);
	expect(body).toContain('href="/blogs/how-to-stop-spam-and-scam-comments-on-youtube/"');
	expect(body.match(/<h2/g)).toHaveLength(2);
	expect(head).toContain('rel="canonical" href="https://moderaty.com/blogs/"');
	expect(body).not.toContain('/guides/');
});

test.each(['https://moderaty.com', 'https://selfhost.example', 'http://localhost:5173'])(
	'blog metadata uses the configured public origin %s',
	async (siteOrigin) => {
		const pages = [
			[(await import('./+page.svelte')).default, '/blogs/'],
			[(await import('./how-to-deal-with-hate-comments-on-youtube/+page.svelte')).default, path]
		] as const;
		for (const [Page, pagePath] of pages) {
			const { head } = render(Page, { props: { data: { ...pageData, siteOrigin } } });
			const canonical = new URL(pagePath, siteOrigin).href;
			const image = new URL('/og.png', siteOrigin).href;
			expect(head).toContain(`rel="canonical" href="${canonical}"`);
			expect(head).toContain(`property="og:url" content="${canonical}"`);
			expect(head).toContain(`property="og:image" content="${image}"`);
			expect(head).toContain(`name="twitter:image" content="${image}"`);
			const schema = JSON.parse(head.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]);
			expect(schema.url).toBe(canonical);
			if (schema['@type'] === 'BlogPosting') expect(schema.mainEntityOfPage).toBe(canonical);
			if (siteOrigin !== pageData.siteOrigin) expect(head).not.toContain('https://moderaty.com');
		}
	}
);

test('the reviewed article has a summary, linked takeaways, FAQs, and the named author bio at the end', async () => {
	const Article = (await import('./how-to-deal-with-hate-comments-on-youtube/+page.svelte')).default;
	const { body } = render(Article, { props: { data: pageData } });
	const clean = body.replaceAll('<!---->', '');
	expect(clean.match(/<h1\b/g)).toHaveLength(1);
	expect(clean).toMatch(/By <a[^>]*href="#about-the-author"[^>]*>Moderaty<\/a>/);
	expect(clean.indexOf('id="summary"')).toBeLessThan(clean.indexOf('id="choose-an-action"'));
	const takeaways = clean.match(/<ul\b[^>]*aria-label="Key takeaways"[^>]*>(.*?)<\/ul>/s)![1];
	expect([...takeaways.matchAll(/<li\b/g)]).toHaveLength(4);
	const ids = new Set([...clean.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id));
	for (const [, id] of takeaways.matchAll(/href="#([^"]+)"/g)) expect(ids.has(id)).toBe(true);
	const faq = clean.slice(clean.indexOf('<h2 id="frequently-asked-questions"'), clean.indexOf('<h2 id="about-the-author"'));
	expect(faq.match(/<h3\b/g)).toHaveLength(4);
	expect(clean).toMatch(/<h2 id="about-the-author"[^>]*>About the author<\/h2>\s*<p[^>]*>.*?Moderaty.*?builds tools.*?<\/p>\s*<\/article>/s);
	expect(clean).not.toMatch(/Editorial review notes|Primary source register|Source-date correction/i);
});

test('external citations open safely and the privacy claim links directly to its process', async () => {
	const Article = (await import('./how-to-deal-with-hate-comments-on-youtube/+page.svelte')).default;
	const { body } = render(Article, { props: { data: pageData } });
	const external = [...body.matchAll(/<a\b([^>]*href="https?:[^>]+)>/g)];
	expect(external.length).toBeGreaterThan(0);
	for (const [, attrs] of external) {
		expect(attrs).toContain('target="_blank"');
		expect(attrs).toMatch(/rel="[^"]*\bnoopener\b/);
	}
	expect(body).toContain('href="https://support.google.com/youtube/answer/142443"');
});
