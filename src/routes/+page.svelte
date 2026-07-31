<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
-->

<script lang="ts">
	import Nav from '$lib/components/landing/Nav.svelte';
	import Hero from '$lib/components/landing/Hero.svelte';
	import TrustBar from '$lib/components/landing/TrustBar.svelte';
	import Benefits from '$lib/components/landing/Benefits.svelte';
	import HowItWorks from '$lib/components/landing/HowItWorks.svelte';
	import Numbers from '$lib/components/landing/Numbers.svelte';
	import Regulars from '$lib/components/landing/Regulars.svelte';
	import Manifesto from '$lib/components/landing/Manifesto.svelte';
	import Faq from '$lib/components/landing/Faq.svelte';
	import FinalCta from '$lib/components/landing/FinalCta.svelte';
	import Footer from '$lib/components/landing/Footer.svelte';

	const FAQ_ENTRIES = [
		{
			q: 'What is Moderaty?',
			a: "Moderaty is comment protection for YouTube creators. It reads every new comment on your channel, enforces your rules instantly, scores the rest with AI across 13 toxicity categories, and holds anything borderline for your one-click review. It's free and open source under AGPL."
		},
		{
			q: 'Will Moderaty ban my real fans?',
			a: "Not by default. Only comments scoring 0.95 or higher on the AI's toxicity scale trigger an automatic ban. Anything uncertain waits in your review queue for a one-click decision, and every action is logged and reversible."
		},
		{
			q: "What happens when the AI isn't sure about a comment?",
			a: "It goes to your queue. If the AI can't score a comment at all, the comment is held for you, never auto-approved and never auto-rejected."
		},
		{
			q: 'Does Moderaty reply to comments or post anything?',
			a: 'No. Moderaty is protection-only. It holds, hides, deletes, and bans. It never writes replies, never posts under your name, and never does growth automation.'
		},
		{
			q: 'What YouTube account access does Moderaty need?',
			a: 'Google OAuth permission to read and moderate comments on your channel. Nothing else. The code is open source under AGPL, so you can verify exactly what it does with that access.'
		},
		{
			q: 'Is Moderaty really free?',
			a: 'Yes. Moderaty is free and open source under the AGPL license. Connect your channel and your next 100 comments are protected in about two minutes of setup.'
		},
		{
			q: 'How is Moderaty different from CommentShark or YouTube Studio?',
			a: 'YouTube Studio flags comments but leaves you to read and act on them. CommentShark automates engagement, including AI replies. Moderaty does one job: enforce your norms so you never have to read the hate.'
		},
		{
			q: 'Can I test Moderaty without changing anything on my channel?',
			a: 'Yes. Dry-run mode classifies everything and changes nothing. The audit trail shows exactly what would have happened, comment by comment.'
		}
	];

	const softwareApplication = {
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		name: 'Moderaty',
		applicationCategory: 'SecurityApplication',
		operatingSystem: 'Web',
		description:
			'Comment protection for YouTube creators. Reads every comment, enforces your rules instantly, scores the rest with AI across 13 toxicity categories, and holds the borderline for one-click review.',
		offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
		license: 'https://www.gnu.org/licenses/agpl-3.0.html'
	};

	const faqPage = {
		'@context': 'https://schema.org',
		'@type': 'FAQPage',
		mainEntity: FAQ_ENTRIES.map((f) => ({
			'@type': 'Question',
			name: f.q,
			acceptedAnswer: { '@type': 'Answer', text: f.a }
		}))
	};

	const jsonLd = (data: object) =>
		'<' + 'script type="application/ld+json">' + JSON.stringify(data) + '</' + 'script>';
</script>

<svelte:head>
	<title>Moderaty | Comment Protection for YouTube Creators</title>
	<meta
		name="description"
		content="Moderaty reads every YouTube comment so you never have to. Your rules plus AI enforce your norms around the clock, hold the borderline, and log everything. Free, open source."
	/>
	<meta property="og:type" content="website" />
	<meta property="og:title" content="Never read another hate comment." />
	<meta
		property="og:description"
		content="Comment protection for YouTube creators. Your community's norms, enforced while you sleep."
	/>
	<meta name="twitter:card" content="summary_large_image" />
	<!-- relative for now — must become an absolute URL at deploy time -->
	<meta property="og:image" content="/og.png" />
	<meta name="twitter:image" content="/og.png" />
	{@html jsonLd(softwareApplication)}
	{@html jsonLd(faqPage)}
</svelte:head>

<Nav />
<main>
	<Hero />
	<TrustBar />
	<Benefits />
	<HowItWorks />
	<Numbers />
	<Regulars />
	<Manifesto />
	<Faq />
	<FinalCta />
</main>
<Footer />
