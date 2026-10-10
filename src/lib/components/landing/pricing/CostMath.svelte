<!--
	The hosted monthly purchase estimator. Same terminal idiom as HowItWorks.
-->

<script lang="ts">
	import { page } from '$app/state';
	import Reveal from '../Reveal.svelte';
	import { estimateHostedMonth, forecastMonths, MAX_CALCULATOR_COMMENTS, MONTHLY_PLAN_USD, validCountInput } from '$lib/landing/cost';

	let moderationCount = $state<number | null | undefined>(undefined);
	let digestCount = $state<number | null | undefined>(0);
	let monthOne = $state<number | null | undefined>(undefined);
	let monthTwo = $state<number | null | undefined>(undefined);
	let monthThree = $state<number | null | undefined>(undefined);
	const locale = $derived(page.data.locale ?? 'en');
	const validInputs = $derived(validCountInput(monthOne) && validCountInput(monthTwo) && validCountInput(monthThree));
	// The forecast needs ALL THREE months — a blank input is not a 0, so a
	// partially filled form shows nothing instead of an instant low estimate.
	const forecast = $derived(validInputs ? forecastMonths([monthOne, monthTwo, monthThree]) : null);
	const monthEstimate = $derived(
		moderationCount != null && digestCount != null && validCountInput(moderationCount) && validCountInput(digestCount)
			? estimateHostedMonth(moderationCount, digestCount)
			: null
	);
	const invalidMonth = $derived(!validCountInput(moderationCount) || !validCountInput(digestCount));
	const formatUsd = (value: number) => new Intl.NumberFormat(locale === 'pt-BR' ? 'pt-BR' : 'en-US', { style: 'currency', currency: 'USD' }).format(value);
	const hasInput = $derived(monthOne != null || monthTwo != null || monthThree != null);
	const label = $derived(locale === 'pt-BR' ? 'classificações de IA' : 'AI classifications');
</script>

<section class="section">
	<Reveal class="math-grid">
		<div>
			<h2 class="section-title">Estimate your hosted month</h2>
			<p class="section-body">
				The hosted subscription renews at $5 a month, even with no AI classifications.
				You get 100 credits shared by AI moderation scoring and feedback digests.
				One moderation score uses one credit; a digest classification uses another.
			</p>
			<p class="section-body">
				Count AI scoring work, including requested history rescans, rather than raw YouTube
				comment volume. Rule and protected-handle moderation decisions use no credit;
				digest classification of those comments still uses one. Retries of the same scan
				do not add another charge.
			</p>
		</div>
		<div class="brackets terminal">
			<div class="brackets-inner">
				<div class="terminal-head">
					<span class="terminal-label">math.txt</span>
				</div>
				<div class="terminal-body">
					<div><span class="t-dim">monthly subscription</span> <span class="t-lit">$5, including zero usage</span></div>
					<div><span class="t-dim">shared allowance</span> <span class="t-lit">100 AI classifications</span></div>
					<div><span class="t-dim">top-up bundles</span> <span class="t-lit">500 / 2,000 credits: $20.40 / $64.65</span></div>
					<div class="t-note">$5/mo renews. automatic top-up is opt-in.</div>
				</div>
			</div>
		</div>
		<div class="calculator-grid" aria-label={locale === 'pt-BR' ? 'Calculadoras de custo' : 'Cost calculators'}>
			<p class="calculator-assumptions">
				Assumes zero purchased credits and the full unused 100-credit allowance for a paid month.
				Assumes both published bundles are available.
				Shows the cheapest manual bundle combination covering your usage. Purchased leftovers
				stay on your balance, so later purchases can be lower. Automatic top-up depends on your
				chosen bundle and threshold; this is an estimate, not a bill.
			</p>
			<div class="calculator">
				<h3>{locale === 'pt-BR' ? 'Calcule seu mês' : 'Calculate your month'}</h3>
				<p class="calculator-copy">{locale === 'pt-BR' ? 'Informe as classificações de moderação e dos resumos separadamente.' : 'Enter moderation scores and digest classifications separately.'}</p>
				<label for="last-month-comments">{locale === 'pt-BR' ? 'Classificações de moderação com IA' : 'AI moderation scores'}</label>
				<input id="last-month-comments" type="number" min="0" max={MAX_CALCULATOR_COMMENTS} step="1" bind:value={moderationCount} placeholder="0" />
				<label for="digest-classifications">{locale === 'pt-BR' ? 'Classificações dos resumos com IA' : 'Feedback digest classifications'}</label>
				<input id="digest-classifications" type="number" min="0" max={MAX_CALCULATOR_COMMENTS} step="1" bind:value={digestCount} aria-describedby="digest-assumption" />
				<p id="digest-assumption" class="calculator-copy">Use 0 with digests off. Otherwise enter the number you expect to classify; cadence, backlog and requested history scans affect it. Digest counts can exceed moderation scores.</p>
				{#if invalidMonth}
					<p class="input-error" role="alert">{locale === 'pt-BR' ? 'Informe um número inteiro válido.' : 'Enter a valid whole number.'}</p>
				{:else if monthEstimate}
					<strong aria-live="polite">{formatUsd(monthEstimate.cashCostUsd)} <span>{locale === 'pt-BR' ? 'total mensal estimado' : 'estimated monthly total'}</span></strong>
					<dl class="estimate-breakdown">
						<div><dt>Subscription</dt><dd>{formatUsd(MONTHLY_PLAN_USD)}</dd></div>
						<div><dt>AI classifications</dt><dd>{monthEstimate.classifications.toLocaleString(locale)}</dd></div>
						<div><dt>Included used</dt><dd>{monthEstimate.includedUsed.toLocaleString(locale)} / 100</dd></div>
						<div><dt>Purchased credits used</dt><dd>{monthEstimate.purchasedUsed.toLocaleString(locale)}</dd></div>
						<div><dt>Top-up purchase</dt><dd>{monthEstimate.topupCredits.toLocaleString(locale)} credits ({formatUsd(monthEstimate.topupCostUsd)})</dd></div>
						<div><dt>Purchased credits left</dt><dd>{monthEstimate.remainingPurchasedCredits.toLocaleString(locale)}</dd></div>
					</dl>
				{/if}
			</div>
			<div class="calculator">
				<h3>{locale === 'pt-BR' ? 'Projete uma faixa' : 'Forecast a range'}</h3>
				<p class="calculator-copy">{locale === 'pt-BR' ? 'Some moderação e resumos em cada mês.' : 'Enter total AI classifications (moderation + digests) for each month.'}</p>
				<div class="month-inputs">
					<label for="month-one">{locale === 'pt-BR' ? 'Mês 1' : 'Month 1'}<input id="month-one" type="number" min="0" max={MAX_CALCULATOR_COMMENTS} step="1" bind:value={monthOne} /></label>
					<label for="month-two">{locale === 'pt-BR' ? 'Mês 2' : 'Month 2'}<input id="month-two" type="number" min="0" max={MAX_CALCULATOR_COMMENTS} step="1" bind:value={monthTwo} /></label>
					<label for="month-three">{locale === 'pt-BR' ? 'Mês 3' : 'Month 3'}<input id="month-three" type="number" min="0" max={MAX_CALCULATOR_COMMENTS} step="1" bind:value={monthThree} /></label>
				</div>
				{#if forecast}
					<p class="forecast" aria-live="polite">{formatUsd(forecast.lowCostUsd)}–{formatUsd(forecast.highCostUsd)} <span>({forecast.lowComments.toLocaleString(locale)}–{forecast.highComments.toLocaleString(locale)} {label})</span></p>
				{:else if hasInput && !validInputs}
					<p class="input-error" role="alert">{locale === 'pt-BR' ? 'Informe números inteiros válidos.' : 'Enter valid whole numbers.'}</p>
				{/if}
				<p class="calculator-copy">Independent monthly zero-balance scenarios; this range does not carry purchased leftovers between months.</p>
			</div>
			<p class="calculator-assumptions">
				This calculator covers the recurring hosted plan. The lifetime plan is $49 once with
				BYOK; self-hosting has no Moderaty subscription. Your OpenAI charges are separate and
				outside this estimate, as are self-hosting infrastructure costs. Read the <a href="/terms#s6">plan and billing terms</a> or check <a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noopener noreferrer">OpenAI API pricing</a> for provider rates.
			</p>
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
	.calculator-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 16px;
		margin-top: 32px;
	}
	.calculator-assumptions { grid-column: 1 / -1; margin: 0; color: rgb(244 244 248 / 0.7); font-size: 13px; line-height: 1.6; }
	.calculator {
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 20px;
		background: var(--surface);
	}
	.calculator h3 { margin: 0; color: var(--paper); font-size: 18px; }
	.calculator-copy { margin: 8px 0 16px; color: rgb(244 244 248 / 0.6); font-size: 13px; }
	.calculator label { display: grid; gap: 6px; color: rgb(244 244 248 / 0.75); font-size: 12px; }
	.calculator > label:not(:first-of-type) { margin-top: 12px; }
	.calculator input { width: 100%; box-sizing: border-box; }
	.calculator > strong { display: block; margin-top: 16px; color: var(--mint); font-family: var(--font-mono); font-size: 20px; }
	.calculator > strong span, .forecast span { color: rgb(244 244 248 / 0.5); font-size: 11px; font-weight: 400; }
	.month-inputs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
	.forecast { margin: 16px 0 0; color: var(--mint); font-family: var(--font-mono); font-size: 18px; }
	.input-error { margin: 12px 0 0; color: var(--brand); font-size: 12px; }
	.estimate-breakdown { margin: 12px 0 0; color: rgb(244 244 248 / 0.7); font-size: 12px; }
	.estimate-breakdown > div { display: flex; justify-content: space-between; gap: 12px; margin-top: 8px; }
	.estimate-breakdown dd { margin: 0; text-align: right; }

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
