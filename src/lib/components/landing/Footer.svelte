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
	import { GITHUB_URL, POLYFORM_URL, CONTACT_URL } from '$lib/landing/links';
	import { LEGAL_DOCS } from '$lib/landing/legal';

	// Illustrative "quiet night": 24 hourly bars, comments handled while the
	// creator slept. Height = comments handled that hour. Pink = actioned,
	// dim = approved quietly.
	const HOURS = [2, 3, 5, 4, 7, 9, 6, 4, 3, 2, 2, 1, 1, 2, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1];
	const ACTIONED = [1, 2, 3, 2, 4, 5, 3, 2, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

	const W = 480;
	const H = 96;
	const GAP = 6;
	const max = Math.max(...HOURS);
	const bw = (W - GAP * (HOURS.length - 1)) / HOURS.length;
	const bars = HOURS.map((h, i) => ({
		x: i * (bw + GAP),
		total: (h / max) * (H - 8),
		acted: (ACTIONED[i] / max) * (H - 8)
	}));
</script>

<footer class="footer">
	<div class="footer-grid">
		<div>
			<div class="wordmark">Moderaty</div>
			<p class="tagline">Built by a creator who got tired of the comments.</p>
			<p class="made-in">
				<img
					src="/capybara-brazil-flag.webp"
					alt="Capybara holding a Brazilian flag"
					width="58"
					height="96"
					class="capy"
				/>
				<span>Made in Brazil</span>
			</p>
			<p class="lgpd-note">
				LGPD (Lei 13.709/2018) compliant. Commenter handles appear in the activity log for up
				to 30 days, then are erased automatically — erase them on demand at any time.
			</p>
			<nav class="footer-links" aria-label="Footer">
				<a href={GITHUB_URL} target="_blank" rel="noreferrer" class="footer-link">GitHub</a>
				<a href={POLYFORM_URL} target="_blank" rel="noreferrer" class="footer-link">PolyForm Shield License</a>
				<a href="/pricing" class="footer-link">Pricing</a>
				<a href="/#faq" class="footer-link">FAQ</a>
				{#each LEGAL_DOCS as doc (doc.slug)}
					<a href="/{doc.slug}" class="footer-link">{doc.label}</a>
				{/each}
				<a href={CONTACT_URL} class="footer-link">Contact</a>
			</nav>
		</div>
		<div class="chart-col">
			<figure class="chart">
				<svg
					viewBox="0 0 {W} {H}"
					class="chart-svg"
					role="img"
					aria-label="Bar chart of comments handled hour by hour overnight, illustrative data"
				>
					{#each bars as b}
						<rect x={b.x} y={H - b.total} width={bw} height={b.total} rx={2} fill="#F4F4F8" opacity={0.18} />
						{#if b.acted > 0}
							<rect x={b.x} y={H - b.acted} width={bw} height={b.acted} rx={2} fill="#EF2D5E" opacity={0.9} />
						{/if}
					{/each}
				</svg>
				<figcaption class="chart-caption">
					A quiet night, visualized: comments handled hour by hour while you slept. Illustrative
					data.
				</figcaption>
			</figure>
		</div>
	</div>
</footer>

<style>
	.footer {
		border-top: 1px solid var(--line);
	}
	.footer-grid {
		max-width: 1152px;
		margin: 0 auto;
		padding: 64px 24px;
		display: grid;
		gap: 48px;
	}
	.wordmark {
		font-family: var(--font-mono);
		font-size: 14px;
		font-weight: 600;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--paper);
	}
	.tagline {
		margin: 16px 0 0;
		max-width: 40ch;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.6);
	}
	.made-in {
		margin: 20px 0 0;
		display: flex;
		align-items: center;
		gap: 12px;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: rgb(244 244 248 / 0.45);
	}
	.lgpd-note {
		margin: 20px 0 0;
		max-width: 44ch;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.7;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: rgb(244 244 248 / 0.45);
	}
	.capy {
		display: block;
		border-radius: var(--radius-sm);
		border: 1px solid var(--line);
	}
	.footer-links {
		margin-top: 24px;
		display: flex;
		flex-wrap: wrap;
		gap: 24px;
	}
	.footer-link {
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: rgb(244 244 248 / 0.55);
		text-decoration: none;
		transition: color 200ms ease;
	}
	.footer-link:hover {
		color: var(--paper);
	}
	.chart {
		margin: 0;
	}
	.chart-svg {
		height: 96px;
		width: 100%;
		max-width: 480px;
	}
	.chart-caption {
		margin-top: 12px;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		line-height: 1.6;
		letter-spacing: 0.14em;
		color: rgb(244 244 248 / 0.4);
	}
	@media (min-width: 1024px) {
		.footer-grid {
			grid-template-columns: 1fr 1fr;
		}
		.chart-col {
			justify-self: end;
		}
	}
</style>
