<script lang="ts">
	import { jsonLd } from '$lib/landing/json-ld';

	let { title, description, path, origin, article = false, author }: {
		title: string;
		description: string;
		path: string;
		origin: string;
		article?: boolean;
		author?: string | { name: string; path: string };
	} = $props();

	let image = $derived(new URL('/og.png', origin).href);
	let canonical = $derived(new URL(path, origin).href);
	let schema = $derived({
		'@context': 'https://schema.org',
		'@type': article ? 'BlogPosting' : 'CollectionPage',
		...(article ? { headline: title, mainEntityOfPage: canonical } : { name: title }),
		...(article && author ? { author: typeof author === 'string'
			? { '@type': 'Person', name: author }
			: { '@type': 'Organization', name: author.name, url: new URL(author.path, origin).href } } : {}),
		description,
		url: canonical,
		inLanguage: 'en'
	});
</script>

<svelte:head>
	<title>{title} | Moderaty</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={canonical} />
	<meta property="og:type" content={article ? 'article' : 'website'} />
	<meta property="og:site_name" content="Moderaty" />
	<meta property="og:title" content="{title} | Moderaty" />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={canonical} />
	<meta property="og:image" content={image} />
	<meta property="og:image:alt" content="Moderaty comment protection for YouTube creators" />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content="{title} | Moderaty" />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content={image} />
	<meta name="twitter:image:alt" content="Moderaty comment protection for YouTube creators" />
	{@html jsonLd(schema)}
</svelte:head>
