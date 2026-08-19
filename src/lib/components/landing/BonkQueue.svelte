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

Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
-->

<!--
	The Bonk Queue: the product's core loop as the hero visual. Scripted
	comments arrive, rules fire, verdicts stamp in with a spring punch, and
	actioned rows settle back. Auto-plays in viewport, pauses off-screen.
	Reduced motion renders the completed night (47/41/6) statically.
-->

<script lang="ts">
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import {
		INITIAL_COUNTS,
		SCRIPT,
		applyArrival,
		applyVerdict,
		initialQueueState,
		type Counts,
		type QueueRow,
		type Verdict
	} from '$lib/landing/queue-script';

	const VERDICT_CLASS: Record<Verdict, string> = {
		APPROVED: 'v-mint',
		HELD: 'v-amber',
		DELETED: 'v-ban',
		BANNED: 'v-ban',
		REJECTED: 'v-ban'
	};

	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

	let root: HTMLDivElement | undefined = $state();
	// SSR and no-JS clients render the completed night; the live loop resets it.
	const initial = initialQueueState();
	let rows: QueueRow[] = $state(initial.rows);
	let counts: Counts = $state(initial.counts);

	onMount(() => {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			// Static completed state is already rendered.
			return;
		}

		rows = [];
		counts = INITIAL_COUNTS;

		let cancelled = false;
		let running = false;
		let onScreen = false;

		const run = async () => {
			if (running) return;
			running = true;
			let idx = 0;
			let key = 0;
			while (!cancelled) {
				// pause off-screen: wait for the viewport before the next arrival
				while (!onScreen && !cancelled) await sleep(250);
				if (cancelled) break;
				const item = SCRIPT[idx % SCRIPT.length];
				const k = key++;
				rows = [...rows.slice(-3), { key: k, item, state: 'incoming' }];
				counts = applyArrival(counts);
				await sleep(1500);
				if (cancelled) break;
				rows = rows.map((r) => (r.key === k ? { ...r, state: 'judged' } : r));
				counts = applyVerdict(counts, item.verdict);
				await sleep(1700);
				if (cancelled) break;
				rows = rows.map((r) => (r.key === k ? { ...r, state: 'settled' } : r));
				await sleep(700);
				idx++;
			}
			running = false;
		};

		const io = new IntersectionObserver(
			(entries) => {
				onScreen = entries[0]?.isIntersecting ?? false;
				if (onScreen) run();
			},
			{ threshold: 0.2 }
		);
		if (root) io.observe(root);
		return () => {
			cancelled = true;
			io.disconnect();
		};
	});
</script>

<div bind:this={root} class="brackets queue" aria-label="Illustrative demonstration of the Moderaty review queue">
	<div class="brackets-inner">
		<!-- Panel header -->
		<div class="panel-head">
			<div class="panel-title">
				<span class="live-dot dot" aria-hidden="true"></span>
				<span class="panel-name">Moderaty queue</span>
			</div>
			<span class="panel-note">an illustrative night</span>
		</div>

		<!-- Counters -->
		<div class="counters">
			<div class="counter">
				<div class="counter-label">Incoming</div>
				<div class="counter-value">{counts.incoming}</div>
			</div>
			<div class="counter">
				<div class="counter-label">Actioned</div>
				<div class="counter-value v-ban">{counts.actioned}</div>
			</div>
			<div class="counter">
				<div class="counter-label">Read by you</div>
				<div class="counter-value v-amber">{counts.yours}</div>
			</div>
		</div>

		<!-- Feed -->
		<div class="feed">
			{#each rows as row (row.key)}
				<div
					class="row"
					class:row-incoming={row.state === 'incoming'}
					class:row-settled={row.state === 'settled'}
					in:fly={{ y: 16, duration: 350, easing: cubicOut }}
					out:fly={{ y: -8, duration: 350, easing: cubicOut }}
				>
					<div class="row-main">
						<div class="row-body">
							<div class="row-author">@{row.item.author}</div>
							<div class="row-text">{row.item.text}</div>
						</div>
						{#if row.state !== 'incoming'}
							<span
								class="stamp stamp-punch row-stamp {VERDICT_CLASS[row.item.verdict]}"
								class:stamp-settled={row.state === 'settled'}
							>
								{row.item.verdict}
							</span>
						{/if}
					</div>
					{#if row.state !== 'incoming'}
						<div class="row-reason">{row.item.reason}</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</div>

<style>
	.queue {
		width: 100%;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-bottom: 1px solid var(--line);
		padding: 12px 16px;
	}
	.panel-title {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--mint);
	}
	.panel-name {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: rgb(244 244 248 / 0.75);
	}
	.panel-note {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: rgb(244 244 248 / 0.4);
	}
	.counters {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		border-bottom: 1px solid var(--line);
	}
	.counter {
		padding: 12px 16px;
	}
	.counter + .counter {
		border-left: 1px solid var(--line);
	}
	.counter-label {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: rgb(244 244 248 / 0.45);
	}
	.counter-value {
		font-family: var(--font-mono);
		font-size: 20px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--paper);
	}
	.v-ban {
		color: var(--ban);
		border-color: var(--ban);
	}
	.v-mint {
		color: var(--mint);
		border-color: var(--mint);
	}
	.v-amber {
		color: var(--amber);
		border-color: var(--amber);
	}
	.feed {
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		gap: 8px;
		min-height: 340px;
		padding: 12px;
	}
	.row {
		position: relative;
		border-radius: 6px;
		border: 1px solid var(--line);
		background: rgb(11 11 20 / 0.6);
		padding: 10px 12px;
		transition: opacity 350ms cubic-bezier(0.23, 1, 0.32, 1);
	}
	.row-incoming {
		border-color: rgb(244 244 248 / 0.25);
		background: var(--ink);
	}
	.row-settled {
		opacity: 0.55;
	}
	.row-main {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}
	.row-body {
		min-width: 0;
	}
	.row-author {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		color: rgb(244 244 248 / 0.6);
	}
	.row-text {
		font-size: 13px;
		line-height: 1.4;
		color: rgb(244 244 248 / 0.9);
		display: -webkit-box;
		-webkit-line-clamp: 1;
		line-clamp: 1;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.row-stamp {
		flex-shrink: 0;
	}
	.stamp-settled {
		animation: none;
		opacity: 1;
		transform: rotate(-8deg) scale(0.85);
	}
	.row-reason {
		margin-top: 4px;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: rgb(244 244 248 / 0.4);
	}
</style>
