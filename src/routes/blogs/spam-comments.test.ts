import { render } from 'svelte/server';
import { expect, test } from 'vitest';
import { SPAM_COMMENTS, SPAM_COMMENT_SECTIONS, SPAM_RULE_EXAMPLES } from '$lib/blogs/spam-comments';
import Article from './how-to-stop-spam-and-scam-comments-on-youtube/+page.svelte';

test('spam guide renders its answer, safe examples, qualified preview route, and complete contents', () => {
	const { body, head } = render(Article, { props: { data: { locale: 'en', siteOrigin: 'https://selfhost.example' } } });
	for (const { id } of SPAM_COMMENT_SECTIONS) {
		expect(body).toContain(`id="${id}"`);
		expect(body).toContain(`href="#${id}"`);
	}
	for (const rule of SPAM_RULE_EXAMPLES) expect(body).toContain(rule.pattern);
	for (const text of ['Key Takeaways', 'About the author', 'Andrew Philip Weilbacher', 'one free moderation dry-run attempt', 'published top-level comments', 'does not verify a hosted channel run']) expect(body).toContain(text);
	expect(body).toMatch(/By <a[^>]*href="#author"[^>]*>Andrew Philip Weilbacher<\/a>/);
	expect(body).toContain('Andrew Philip Weilbacher is the founder of Moderaty and a YouTube Creator.');
	expect(body).toContain('href="/login"');
	expect(body).not.toMatch(/href="https?:\/\/example\.invalid|MC-21|Editorial review notes|\/guides\//);
	expect(body.match(/scope="row"/g)).toHaveLength(4);
	expect(body.match(/scope="col"/g)).toHaveLength(3);
	for (const [, attrs] of body.matchAll(/<a\s+([^>]*href="https?:\/\/[^>]+)>/g)) {
		expect(attrs).toContain('target="_blank"');
		expect(attrs).toContain('rel="noopener noreferrer"');
	}
	expect(head).toContain(`rel="canonical" href="https://selfhost.example${SPAM_COMMENTS.path}"`);
	const schema = JSON.parse(head.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]);
	expect(schema).toMatchObject({ '@type': 'BlogPosting', author: { '@type': 'Person', name: 'Andrew Philip Weilbacher' }, url: `https://selfhost.example${SPAM_COMMENTS.path}` });
	expect(schema).not.toHaveProperty('datePublished');
});
