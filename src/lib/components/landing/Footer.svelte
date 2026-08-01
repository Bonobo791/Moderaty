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
	import { GITHUB_URL, AGPL_URL, CONTACT_URL } from '$lib/landing/links';

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
				<svg viewBox="0 0 44 40" width="30" height="27" role="img" aria-label="Capybara holding a Brazilian flag">
					<!-- flag pole, held at the head -->
					<rect x="31.6" y="2" width="1.6" height="18" rx="0.8" fill="#b08968" />
					<!-- Brazilian flag -->
					<rect x="33.2" y="2" width="10.8" height="7.6" rx="1" fill="#009b3a" />
					<path d="M38.6 3.1 42.2 5.8 38.6 8.5 35 5.8Z" fill="#fedf00" />
					<circle cx="38.6" cy="5.8" r="1.4" fill="#002776" />
					<!-- capybara -->
					<g fill="#b08968">
						<rect x="2" y="19" width="22" height="13" rx="6.5" />
						<rect x="20" y="14" width="11.5" height="11.5" rx="4.5" />
						<circle cx="27.5" cy="13.5" r="2" />
						<rect x="5" y="30" width="3.4" height="6" rx="1.7" />
						<rect x="17" y="30" width="3.4" height="6" rx="1.7" />
					</g>
					<circle cx="27.2" cy="19" r="1.2" fill="#0b0b14" />
					<circle cx="30" cy="23.2" r="1.1" fill="#0b0b14" />
				</svg>
				<span>Made in Brazil</span>
			</p>
			<nav class="footer-links" aria-label="Footer">
				<a href={GITHUB_URL} target="_blank" rel="noreferrer" class="footer-link">GitHub</a>
				<a href={AGPL_URL} target="_blank" rel="noreferrer" class="footer-link">AGPL-3.0 License</a>
				<a href="/pricing" class="footer-link">Pricing</a>
				<a href="/#faq" class="footer-link">FAQ</a>
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
		gap: 10px;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: rgb(244 244 248 / 0.45);
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
