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

<!--
	The math.txt terminal: turns YouTube Studio's comment count into a
	budget. Same bracketed-terminal idiom as HowItWorks.
-->

<script lang="ts">
	import { page } from '$app/state';
	import Reveal from '../Reveal.svelte';
	import { forecastCost, hostedCostUsd, MAX_CALCULATOR_COMMENTS } from '$lib/landing/cost';

	let monthOne = $state<number | undefined>(undefined);
	let monthTwo = $state<number | undefined>(undefined);
	let monthThree = $state<number | undefined>(undefined);
	const locale = $derived(page.data.locale ?? 'en');
	const counts = $derived([monthOne ?? 0, monthTwo ?? 0, monthThree ?? 0]);
	const validCount = (value: number | undefined) => value === undefined || (Number.isSafeInteger(value) && value >= 0 && value <= MAX_CALCULATOR_COMMENTS);
	const validInputs = $derived(validCount(monthOne) && validCount(monthTwo) && validCount(monthThree));
	const forecast = $derived(validInputs ? forecastCost(counts) : null);
	const lastMonthCost = $derived(monthOne === undefined ? null : validCount(monthOne) ? hostedCostUsd(monthOne) : null);
	const formatUsd = (value: number) => new Intl.NumberFormat(locale === 'pt-BR' ? 'pt-BR' : 'en-US', { style: 'currency', currency: 'USD' }).format(value);
	const hasInput = $derived(monthOne !== undefined || monthTwo !== undefined || monthThree !== undefined);
	const label = $derived(locale === 'pt-BR' ? 'comentários' : 'comments');
</script>

<section class="section">
	<Reveal class="math-grid">
		<div>
			<h2 class="section-title">What would your month cost?</h2>
			<p class="section-body">
				Open YouTube Studio and check last month's comment count. The first 100 are the $5
				subscription. Everything past that is a nickel a comment, topped up manually or
				automatically — your call. If last month rounds to zero, the free tier is waving at you.
			</p>
		</div>
		<div class="brackets terminal">
			<div class="brackets-inner">
				<div class="terminal-head">
					<span class="terminal-label">math.txt</span>
				</div>
				<div class="terminal-body">
					<div><span class="t-dim">comments last month</span> <span class="t-lit">see YouTube Studio</span></div>
					<div><span class="t-dim">covered by the plan</span> <span class="t-lit">first 100 ($5/mo)</span></div>
					<div><span class="t-dim">top-up beyond that</span> <span class="t-lit">(comments − 100) × $0.05</span></div>
					<div><span class="t-dim">nights reading hate</span> <span class="t-mint">0</span></div>
					<div class="t-note">$5/mo renews. automatic top-up is opt-in.</div>
				</div>
			</div>
		</div>
		<div class="calculator-grid" aria-label={locale === 'pt-BR' ? 'Calculadoras de custo' : 'Cost calculators'}>
			<div class="calculator">
				<h3>{locale === 'pt-BR' ? 'Calcule seu mês' : 'Calculate your month'}</h3>
				<p class="calculator-copy">{locale === 'pt-BR' ? 'Informe o volume de comentários do mês passado.' : 'Enter last month’s comment volume.'}</p>
				<label for="last-month-comments">{locale === 'pt-BR' ? 'Comentários no último mês' : 'Comments last month'}</label>
				<input id="last-month-comments" type="number" min="0" max={MAX_CALCULATOR_COMMENTS} step="1" bind:value={monthOne} placeholder="0" />
				{#if lastMonthCost === null}
					<p class="input-error" role="alert">{locale === 'pt-BR' ? 'Informe um número inteiro válido.' : 'Enter a valid whole number.'}</p>
				{:else}
					<strong>{formatUsd(lastMonthCost)} <span>/ {locale === 'pt-BR' ? 'mês' : 'month'}</span></strong>
				{/if}
			</div>
			<div class="calculator">
				<h3>{locale === 'pt-BR' ? 'Projete uma faixa' : 'Forecast a range'}</h3>
				<p class="calculator-copy">{locale === 'pt-BR' ? 'Use os últimos três meses para uma faixa simples.' : 'Use the last three months for a simple range.'}</p>
				<div class="month-inputs">
					<label for="month-one">{locale === 'pt-BR' ? 'Mês 1' : 'Month 1'}<input id="month-one" type="number" min="0" max={MAX_CALCULATOR_COMMENTS} step="1" bind:value={monthOne} /></label>
					<label for="month-two">{locale === 'pt-BR' ? 'Mês 2' : 'Month 2'}<input id="month-two" type="number" min="0" max={MAX_CALCULATOR_COMMENTS} step="1" bind:value={monthTwo} /></label>
					<label for="month-three">{locale === 'pt-BR' ? 'Mês 3' : 'Month 3'}<input id="month-three" type="number" min="0" max={MAX_CALCULATOR_COMMENTS} step="1" bind:value={monthThree} /></label>
				</div>
				{#if hasInput && forecast}
					<p class="forecast" aria-live="polite">{formatUsd(forecast.lowCostUsd)}–{formatUsd(forecast.highCostUsd)} <span>({forecast.lowComments.toLocaleString(locale)}–{forecast.highComments.toLocaleString(locale)} {label})</span></p>
				{:else if hasInput}
					<p class="input-error" role="alert">{locale === 'pt-BR' ? 'Informe números inteiros válidos.' : 'Enter valid whole numbers.'}</p>
				{/if}
			</div>
		</div>
	</Reveal>
</section>

<style>
	.section {
		max-width: 1152px;
		margin: 0 auto;
		padding: 64px 24px;
	}
	.section-title {
		font-family: var(--font-display);
		font-size: 40px;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--paper);
		margin: 0;
	}
	.section-body {
		margin: 16px 0 0;
		max-width: 58ch;
		line-height: 1.6;
		color: rgb(244 244 248 / 0.7);
	}
	:global(.math-grid) {
		display: grid;
		align-items: center;
		gap: 32px;
	}
	.terminal {
		border-radius: var(--radius);
		border: 1px solid var(--line);
		background: var(--surface);
	}
	.terminal-head {
		border-bottom: 1px solid var(--line);
		padding: 10px 16px;
	}
	.terminal-label {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: rgb(244 244 248 / 0.45);
	}
	.terminal-body {
		padding: 16px;
		font-family: var(--font-mono);
		font-size: 13px;
		line-height: 2;
		overflow-x: auto;
	}
	.t-dim { color: rgb(244 244 248 / 0.45); }
	.t-lit { color: rgb(244 244 248 / 0.85); }
	.t-mint { color: var(--mint); font-weight: 600; }
	.calculator-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 16px;
		margin-top: 32px;
	}
	.calculator {
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 20px;
		background: var(--surface);
	}
	.calculator h3 { margin: 0; color: var(--paper); font-size: 18px; }
	.calculator-copy { margin: 8px 0 16px; color: rgb(244 244 248 / 0.6); font-size: 13px; }
	.calculator label { display: grid; gap: 6px; color: rgb(244 244 248 / 0.75); font-size: 12px; }
	.calculator input { width: 100%; box-sizing: border-box; }
	.calculator > strong { display: block; margin-top: 16px; color: var(--mint); font-family: var(--font-mono); font-size: 20px; }
	.calculator > strong span, .forecast span { color: rgb(244 244 248 / 0.5); font-size: 11px; font-weight: 400; }
	.month-inputs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
	.forecast { margin: 16px 0 0; color: var(--mint); font-family: var(--font-mono); font-size: 18px; }
	.input-error { margin: 12px 0 0; color: var(--brand); font-size: 12px; }

	.t-note {
		margin-top: 12px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: rgb(244 244 248 / 0.35);
	}
	@media (min-width: 768px) {
		.section-title {
			font-size: 48px;
		}
	}
	@media (min-width: 1024px) {
		:global(.math-grid) {
			grid-template-columns: 1fr 1fr;
			gap: 64px;
		}
	}
</style>
