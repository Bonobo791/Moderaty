<script lang="ts">
	import BlogMeta from '$lib/components/blogs/BlogMeta.svelte';
	import { HATE_COMMENTS } from '$lib/blogs/hate-comments';
	import { SPAM_COMMENTS } from '$lib/blogs/spam-comments';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	const description = 'Practical advice for YouTube creators on hate comments, spam and scams, useful criticism, and channel moderation.';
</script>

<BlogMeta title="YouTube comment moderation blog" {description} path="/blogs/" origin={data.siteOrigin} />

<nav class="breadcrumbs" aria-label="Breadcrumb">
	<ol><li><a href="/">Home</a></li><li aria-current="page">Blogs</li></ol>
</nav>
<h1>YouTube comment moderation blog</h1>
<p>{description}</p>
<article>
	<h2><a href={HATE_COMMENTS.path}>{HATE_COMMENTS.title}</a></h2>
	<p>{HATE_COMMENTS.description}</p>
</article>
<article>
	<h2><a href={SPAM_COMMENTS.path}>{SPAM_COMMENTS.title}</a></h2>
	<p>{SPAM_COMMENTS.description}</p>
</article>
