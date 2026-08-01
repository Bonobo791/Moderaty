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
	import type { Snippet } from 'svelte';

	type TocEntry = { id: string; label: string };

	let {
		kicker,
		title,
		version,
		effectiveDate,
		toc = [],
		children
	}: {
		kicker: string;
		title: string;
		version: string;
		effectiveDate: string;
		toc?: TocEntry[];
		children: Snippet;
	} = $props();
</script>

<article class="legal-doc">
	<header class="legal-head">
		<p class="kicker">{kicker}</p>
		<h1>{title}</h1>
		<p class="doc-meta">Version {version} — effective {effectiveDate}</p>
	</header>

	{#if toc.length > 0}
		<nav class="toc" aria-label="Contents">
			<p class="toc-title">Contents</p>
			<ol>
				{#each toc as entry (entry.id)}
					<li><a href="#{entry.id}">{entry.label}</a></li>
				{/each}
			</ol>
		</nav>
	{/if}

	<div class="legal-body">
		{@render children()}
	</div>
</article>

<style>
	.legal-doc {
		max-width: 760px;
		margin: 0 auto;
		padding: 96px 24px 80px;
	}
	.legal-head {
		border-bottom: 1px solid var(--line);
		padding-bottom: 32px;
		margin-bottom: 40px;
	}
	.kicker {
		margin: 0 0 16px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--ban);
	}
	h1 {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(32px, 6vw, 48px);
		font-weight: 800;
		letter-spacing: -0.02em;
		line-height: 1.05;
		color: var(--paper);
	}
	.doc-meta {
		margin: 16px 0 0;
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: rgb(244 244 248 / 0.45);
	}
	.toc {
		margin-bottom: 48px;
		padding: 20px 24px;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.toc-title {
		margin: 0 0 12px;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: rgb(244 244 248 / 0.45);
	}
	.toc ol {
		margin: 0;
		padding-left: 0;
		list-style: none;
		columns: 2;
		column-gap: 32px;
	}
	.toc li {
		margin: 6px 0;
		font-size: 14px;
		break-inside: avoid;
	}
	.toc a {
		color: rgb(244 244 248 / 0.7);
		text-decoration: none;
	}
	.toc a:hover {
		color: var(--paper);
		text-decoration: underline;
	}

	/* Body typography — CDC Art. 54 §3 keeps body text at 12pt (16px) or larger. */
	.legal-body {
		font-size: 16px;
		line-height: 1.7;
		color: rgb(244 244 248 / 0.78);
	}
	.legal-body :global(h2) {
		margin: 56px 0 16px;
		font-family: var(--font-display);
		font-size: 24px;
		font-weight: 700;
		letter-spacing: -0.01em;
		color: var(--paper);
		scroll-margin-top: 96px;
	}
	.legal-body :global(h3) {
		margin: 32px 0 12px;
		font-family: var(--font-display);
		font-size: 18px;
		font-weight: 700;
		color: var(--paper);
	}
	.legal-body :global(p) {
		margin: 14px 0;
	}
	.legal-body :global(ol),
	.legal-body :global(ul) {
		margin: 14px 0;
		padding-left: 24px;
	}
	.legal-body :global(li) {
		margin: 8px 0;
	}
	.legal-body :global(strong) {
		color: var(--paper);
	}
	.legal-body :global(a) {
		color: var(--ban);
	}
	.legal-body :global(.table-wrap) {
		overflow-x: auto;
		margin: 20px 0;
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.legal-body :global(table) {
		width: 100%;
		border-collapse: collapse;
		font-size: 14px;
	}
	.legal-body :global(th),
	.legal-body :global(td) {
		padding: 12px 16px;
		text-align: left;
		vertical-align: top;
		border-bottom: 1px solid var(--line);
	}
	.legal-body :global(tr:last-child td) {
		border-bottom: none;
	}
	.legal-body :global(th) {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: rgb(244 244 248 / 0.5);
		background: var(--surface);
	}
	.legal-body :global(td:first-child) {
		color: var(--paper);
		font-weight: 600;
		white-space: nowrap;
	}
	/* CDC Art. 54 §4: clauses limiting user rights stay visually highlighted. */
	.legal-body :global(.highlight) {
		display: block;
		margin: 20px 0;
		padding: 16px 20px;
		border: 1px solid var(--ban);
		border-radius: var(--radius);
		background: var(--brand-soft);
		font-weight: 700;
		color: var(--paper);
	}

	@media (max-width: 640px) {
		.legal-doc {
			padding: 72px 20px 64px;
		}
		.toc ol {
			columns: 1;
		}
		.legal-body :global(td:first-child) {
			white-space: normal;
		}
	}
</style>
