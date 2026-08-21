<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher

Licensed under the PolyForm Shield License 1.0.0; you may not use
this file except in compliance with the License. You may obtain a
copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.

The software is provided "as is", without warranty or condition of
any kind, express or implied. See the License for the specific
language governing permissions and limitations under the License.
A copy of the License is included in the LICENSE file at the
repository root.

Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md
-->

<script lang="ts">
	import Icon from './Icon.svelte';
	import { FEEDBACK_URL, GITHUB_URL, LOGIN_URL } from '$lib/landing/links';

	const LINKS = [
		{ label: 'How it works', href: '/#how-it-works' },
		{ label: 'Who gets bonked', href: '/#regulars' },
		{ label: 'The numbers', href: '/#numbers' },
		{ label: 'Pricing', href: '/pricing' },
		{ label: 'FAQ', href: '/#faq' }
	];

	let open = $state(false);
</script>

<header class="nav">
	<div class="nav-inner">
		<a href="/#top" class="wordmark">Moderaty</a>
		<nav class="links" aria-label="Primary">
			{#each LINKS as l}
				<a href={l.href} class="link">{l.label}</a>
			{/each}
			<a href={GITHUB_URL} target="_blank" rel="noreferrer" class="link">GitHub</a>
			<a href={FEEDBACK_URL} target="_blank" rel="noreferrer" class="link">Feedback</a>
		</nav>
		<div class="nav-actions">
			<a href={LOGIN_URL} class="btn-press cta">Connect YouTube channel</a>
			<button
				class="btn-press menu-btn"
				onclick={() => (open = !open)}
				aria-label={open ? 'Close menu' : 'Open menu'}
				aria-expanded={open}
			>
				<Icon name={open ? 'x' : 'list'} size={22} />
			</button>
		</div>
	</div>
	{#if open}
		<nav class="mobile-links" aria-label="Mobile">
			{#each LINKS as l}
				<a href={l.href} class="mobile-link" onclick={() => (open = false)}>{l.label}</a>
			{/each}
			<a href={GITHUB_URL} target="_blank" rel="noreferrer" class="mobile-link">GitHub</a>
			<a href={FEEDBACK_URL} target="_blank" rel="noreferrer" class="mobile-link">Feedback</a>
			<a href={LOGIN_URL} class="btn-press cta mobile-cta">Connect YouTube channel</a>
		</nav>
	{/if}
</header>

<style>
	.nav {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 50;
		border-bottom: 1px solid var(--line);
		background: rgb(11 11 20 / 0.85);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
	}
	.nav-inner {
		max-width: 1152px;
		margin: 0 auto;
		padding: 0 24px;
		height: 64px;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.wordmark {
		font-family: var(--font-mono);
		font-size: 14px;
		font-weight: 600;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--paper);
		text-decoration: none;
	}
	.links {
		display: none;
		align-items: center;
		gap: 28px;
	}
	.link {
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: rgb(244 244 248 / 0.55);
		text-decoration: none;
		transition: color 200ms ease;
	}
	.link:hover {
		color: var(--paper);
	}
	.nav-actions {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.cta {
		display: none;
		border-radius: 999px;
		background: var(--ban);
		color: var(--ink);
		font-size: 14px;
		font-weight: 600;
		padding: 10px 20px;
		text-decoration: none;
	}
	.menu-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: 0;
		color: var(--paper);
		cursor: pointer;
		padding: 6px;
	}
	.mobile-links {
		border-top: 1px solid var(--line);
		background: var(--ink);
		padding: 16px 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.mobile-link {
		font-family: var(--font-mono);
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: rgb(244 244 248 / 0.7);
		text-decoration: none;
	}
	.mobile-cta {
		display: inline-block;
		width: fit-content;
		margin-top: 8px;
	}
	@media (min-width: 1024px) {
		.links {
			display: flex;
		}
		.cta {
			display: inline-block;
		}
		.menu-btn {
			display: none;
		}
		.mobile-links {
			display: none;
		}
	}
</style>
