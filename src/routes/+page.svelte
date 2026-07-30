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
	import { onMount } from 'svelte';

	// The cue sheet: each section is one lighting cue of the night shift.
	const cues = [
		{ id: 'lx-00', num: 'LX-00', name: 'STANDBY', time: '00.00' },
		{ id: 'lx-01', num: 'LX-01', name: 'NIGHT', time: '10.00' },
		{ id: 'lx-02', num: 'LX-02', name: 'COBALT HORIZON', time: '20.00' },
		{ id: 'lx-03', num: 'LX-03', name: 'ROSE GATHER', time: '30.00' },
		{ id: 'lx-04', num: 'LX-04', name: 'DAWN WASH', time: '40.00' },
		{ id: 'lx-05', num: 'LX-05', name: 'DAY', time: '50.00' }
	];

	let active = $state('lx-00');
	const currentCue = $derived(cues.find((c) => c.id === active) ?? cues[0]);
	let live = $state(false);
	let sky: HTMLDivElement | undefined = $state();

	onMount(() => {
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

		// Active-cue tracking works in both modes; the animated cyc only
		// engages when motion is welcome. Without JS the static per-cue
		// horizon bands below carry the whole story.
		const observer = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						active = e.target.id;
						e.target.querySelector('.cue-inner')?.classList.add('in');
					}
				}
			},
			{ rootMargin: '-40% 0px -55% 0px' }
		);
		document.querySelectorAll('.cue').forEach((el) => observer.observe(el));

		if (reduced) return () => observer.disconnect();

		live = true;
		let raf = 0;
		const onScroll = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				if (!sky) return;
				const doc = document.documentElement;
				const p = Math.min(1, Math.max(0, doc.scrollTop / (doc.scrollHeight - doc.clientHeight)));
				const shift = p * (sky.offsetHeight - window.innerHeight);
				sky.style.transform = `translate3d(0, ${-shift}px, 0)`;
			});
		};
		onScroll();
		window.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			observer.disconnect();
			window.removeEventListener('scroll', onScroll);
			if (raf) cancelAnimationFrame(raf);
		};
	});
</script>

<svelte:head>
	<title>Moderaty — Never read another hate comment.</title>
	<meta
		name="description"
		content="Comment protection for YouTube creators — your community's norms, enforced while you sleep. Rules first, AI second, you on doubt."
	/>
	<meta property="og:type" content="website" />
	<meta property="og:title" content="Moderaty — Never read another hate comment." />
	<meta
		property="og:description"
		content="Comment protection for YouTube creators — your community's norms, enforced while you sleep. Rules first, AI second, you on doubt."
	/>
	<meta name="twitter:card" content="summary_large_image" />
	<!-- relative for now — must become an absolute URL at deploy time -->
	<meta property="og:image" content="/og.png" />
	<meta name="twitter:image" content="/og.png" />
</svelte:head>

<div class="page" class:live>
	<!-- The cyclorama: one tall sky, raised cue by cue as the night shift runs. -->
	<div class="cyc" aria-hidden="true"><div class="sky" bind:this={sky}></div></div>

	<header class="cue-strip">
		<a class="strip-brand" href="#lx-00">Moderaty</a>
		<nav class="strip-cues" aria-label="Cue sheet">
			{#each cues as c}
				<a
					href="#{c.id}"
					class="strip-cue"
					class:current={active === c.id}
					aria-current={active === c.id ? 'location' : undefined}
					aria-label="Jump to cue {c.num}, {c.name}"
				>
					<span class="cue-num">{c.num}</span>
					<span class="cue-name">{c.name}</span>
				</a>
			{/each}
		</nav>
		<p class="strip-current"><span class="sc-num">{currentCue.num} · </span>{currentCue.name}</p>
		<a class="strip-cta" href="/api/auth/google">Connect</a>
	</header>

	<main>
	<!-- LX-00 · STANDBY -->
	<section class="cue night-text s0" id="lx-00" aria-label="Standby">
		<div class="cue-inner">
			<p class="cue-tag"><span>LX-00</span> STANDBY <span class="cue-time">00.00</span></p>
			<h1>Never read another hate comment.</h1>
			<p class="lede">Comment protection for YouTube creators — your community&rsquo;s norms, enforced while you sleep.</p>
			<p class="monitor">
				INCOMING 47 · ACTIONED 0 · READ BY YOU 0
				<span class="monitor-note">(an illustrative night)</span>
			</p>
			<div class="actions">
				<a class="btn-activate" href="/api/auth/google">Connect YouTube channel</a>
				<a class="btn-preview" href="#lx-01">Watch the night shift</a>
			</div>
			<p class="cta-fine">
				Google will ask for YouTube account access — Moderaty uses it to read and moderate
				comments, nothing more. Free and open source (AGPL).
			</p>
		</div>
	</section>

	<!-- LX-01 · NIGHT -->
	<section class="cue night-text s1" id="lx-01" aria-label="Night">
		<div class="cue-inner">
			<p class="cue-tag"><span>LX-01</span> NIGHT <span class="cue-time">10.00</span></p>
			<h2>&ldquo;Just don&rsquo;t read the comments&rdquo; is not a strategy. It&rsquo;s a surrender.</h2>
			<p>
				It&rsquo;s 1 a.m. The badge says 47. Somewhere in the pile is a regular with a real
				question — and someone who showed up to ruin your week. You&rsquo;ve learned to feel the
				difference in your stomach before you read a single word.
			</p>
			<p>
				Moderaty exists so the pile is handled before it becomes your morning. Every new comment
				is read, judged against your rules, scored, and sorted — while the app stays closed.
			</p>
		</div>
	</section>

	<!-- LX-02 · COBALT HORIZON -->
	<section class="cue night-text s2" id="lx-02" aria-label="Cobalt horizon">
		<div class="cue-inner">
			<p class="cue-tag"><span>LX-02</span> COBALT HORIZON <span class="cue-time">20.00</span></p>
			<h2>Your rules fire first.</h2>
			<p>
				Write your community&rsquo;s norms in plain English: keywords, patterns, people. Every
				new comment meets your rules before anything else touches it, and a rule hit acts
				immediately — hold it, reject it, delete it, or ban the author.
			</p>
			<div class="plot" role="list" aria-label="Example rules">
				<p role="listitem"><span class="plot-kind">KEYWORD</span> &ldquo;crypto giveaway&rdquo; <span class="plot-arrow">&rarr;</span> DELETE</p>
				<p role="listitem"><span class="plot-kind">REGEX</span> ^https?:// <span class="plot-arrow">&rarr;</span> HOLD FOR REVIEW</p>
				<p role="listitem"><span class="plot-kind">USER</span> UC&hellip; <span class="plot-arrow">&rarr;</span> REJECT + BAN AUTHOR</p>
				<p class="plot-note">examples — your rules are yours</p>
			</div>
			<p class="fine">
				Your regexes run under RE2, so a pattern can never be turned against the app itself.
			</p>
		</div>
	</section>

	<!-- LX-03 · ROSE GATHER -->
	<section class="cue night-text s3" id="lx-03" aria-label="Rose gather">
		<div class="cue-inner">
			<p class="cue-tag"><span>LX-03</span> ROSE GATHER <span class="cue-time">30.00</span></p>
			<h2>Then the AI scores what your rules miss.</h2>
			<p>
				Every comment your rules don&rsquo;t catch is scored by OpenAI&rsquo;s moderation model
				across six toxicity categories. The highest score decides:
			</p>
			<div class="plot" role="list" aria-label="Score thresholds">
				<p role="listitem"><span class="plot-kind">&gt; 0.85</span> AUTHOR BANNED AUTOMATICALLY</p>
				<p role="listitem"><span class="plot-kind">0.51 – 0.85</span> DELETED AUTOMATICALLY</p>
				<p role="listitem"><span class="plot-kind">0.35 – 0.50</span> HELD FOR YOUR REVIEW</p>
				<p role="listitem"><span class="plot-kind">&lt; 0.35</span> APPROVED</p>
			</div>
			<p class="fine">
				If the AI can&rsquo;t score a comment, it lands in your queue — never auto-approved,
				never auto-rejected.
			</p>
		</div>
	</section>

	<!-- LX-04 · DAWN WASH -->
	<section class="cue day-text s4" id="lx-04" aria-label="Dawn wash">
		<div class="cue-inner">
			<p class="cue-tag"><span>LX-04</span> DAWN WASH <span class="cue-time">40.00</span></p>
			<h2>Doubt is always yours to decide.</h2>
			<p>
				Borderline comments wait in your review queue — one click to approve, reject, delete,
				or ban. Every enforcement action is written to the audit log <em>before</em> it happens
				on YouTube, so a crash mid-run never loses an action and never repeats one.
			</p>
			<p>
				Want proof before commitment? Dry-run mode classifies everything and changes nothing —
				the audit trail shows exactly what would have happened, comment by comment.
			</p>
		</div>
	</section>

	<!-- LX-05 · DAY -->
	<section class="cue day-text s5" id="lx-05" aria-label="Day">
		<div class="cue-inner">
			<p class="cue-tag"><span>LX-05</span> DAY <span class="cue-time">50.00</span></p>
			<h2>Every other comment tool wants to grow your channel. Moderaty wants to protect you.</h2>
			<div class="actions">
				<a class="btn-activate" href="/api/auth/google">Connect YouTube channel</a>
			</div>
		</div>
	</section>
	</main>

	<footer class="day-footer">
		<div class="footer-inner">
			Open source under
			<a href="https://github.com/Bonobo791/Moderaty/blob/main/LICENSE">AGPL</a> ·
			<a href="https://github.com/Bonobo791/Moderaty#readme">Self-host it</a> or use the
			hosted service ·
			<a href="mailto:contact@marketingprowess.simplelogin.com">Commercial licensing</a>
			available · &copy; 2026 Andrew Philip Weilbacher
		</div>
	</footer>
</div>

<style>
	.page {
		--strip-h: 56px;
		background: var(--night);
	}

	/* ── the cyclorama: hidden until JS confirms motion is welcome ── */
	.cyc { display: none; }
	.live .cyc {
		display: block;
		position: fixed;
		inset: 0;
		overflow: hidden;
		z-index: 0;
	}
	.sky {
		height: 520vh;
		background: linear-gradient(
			180deg,
			var(--night) 0%,
			var(--night) 14%,
			#071248 22%,
			#081350 31%,
			var(--cobalt) 45%,
			#5a4fd6 64%,
			var(--rose-light) 70%,
			var(--dawn) 78%,
			#fff3f8 85%,
			var(--day) 91%,
			var(--day) 100%
		);
		will-change: transform;
	}
	.live .cue { background: transparent; }

	/* ── cue sections; each carries its own static horizon band so the
	      story survives no-JS and reduced-motion ── */
	.cue {
		position: relative;
		z-index: 1;
		min-height: 92vh;
		display: flex;
		align-items: center;
		padding: calc(var(--strip-h) + 48px) 24px 72px;
	}
	.s0 { background: linear-gradient(180deg, var(--night) 55%, #071248 88%, #0a2bff 135%); }
	.s1 { background: linear-gradient(180deg, var(--night) 0%, #081350 100%); }
	.s2 { background: linear-gradient(180deg, #081350 0%, var(--cobalt) 100%); }
	.s3 { background: linear-gradient(180deg, var(--cobalt) 0%, #5a4fd6 72%, var(--rose-light) 155%); }
	.s4 { background: linear-gradient(180deg, #ff9ec2 0%, var(--dawn) 25%, #fff3f8 100%); }
	.s5 { background: linear-gradient(180deg, #fff3f8 0%, var(--day) 30%); }

	.cue-inner { max-width: 780px; margin: 0 auto; width: 100%; }
	.live .cue-inner {
		opacity: 0;
		transform: translateY(28px);
		transition: opacity 700ms cubic-bezier(0.16, 1, 0.3, 1), transform 700ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	.live .cue-inner:global(.in) { opacity: 1; transform: none; }

	/* ── type themes per phase ── */
	.night-text { color: var(--day); }
	.night-text p { color: var(--night-prose); }
	.day-text { color: var(--ink); }
	.day-text p { color: var(--day-prose); }

	.cue-tag {
		font-family: var(--font-cue);
		font-size: 15px;
		letter-spacing: 0.08em;
		margin: 0 0 20px;
		font-variant-numeric: tabular-nums;
	}
	.cue-tag span { color: var(--dawn); }
	.day-text .cue-tag span { color: var(--ink); }
	.cue-tag .cue-time { float: right; color: inherit; opacity: 0.75; }
	.day-text .cue-tag .cue-time { opacity: 1; }

	h1, h2 {
		font-family: var(--font-display);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.005em;
		line-height: 1.02;
		text-wrap: balance;
		margin: 0 0 22px;
		color: inherit;
	}
	h1 { font-size: clamp(2.8rem, 8.5vw, 5.75rem); }
	h2 { font-size: clamp(2rem, 5.5vw, 3.6rem); }

	.cue-inner > p { max-width: 62ch; font-size: 17px; line-height: 1.65; margin: 0 0 16px; }
	.cue-inner > p:not(.cue-tag):not(.monitor) { font-family: 'Saira', system-ui, sans-serif; }
	.cue-inner > .lede { font-size: 21px; font-weight: 500; }
	.cue-inner > .fine { font-size: 14px; }
	.night-text .fine { color: var(--night-fine); }

	.monitor {
		font-family: var(--font-cue);
		font-size: 13px;
		letter-spacing: 0.1em;
		font-variant-numeric: tabular-nums;
	}
	.cue-inner > .monitor { color: var(--rose-light); margin: 34px 0 8px; }
	.monitor-note { color: var(--night-dim); letter-spacing: 0.04em; }

	.cta-fine {
		font-size: 13px;
		line-height: 1.55;
		color: var(--night-dim);
		max-width: 52ch;
		margin-top: 16px;
	}

	/* ── the lighting plot: rules and thresholds as cue rows ── */
	.plot {
		margin: 26px 0 18px;
		border-top: 1px solid currentColor;
		font-variant-numeric: tabular-nums;
	}
	.plot p {
		display: flex;
		gap: 14px;
		align-items: baseline;
		font-size: 15px;
		margin: 0;
		padding: 11px 2px;
		border-bottom: 1px solid color-mix(in srgb, currentColor 28%, transparent);
		max-width: none;
	}
	.plot-kind {
		font-family: var(--font-cue);
		font-size: 12px;
		letter-spacing: 0.08em;
		min-width: 150px;
		color: var(--dawn);
	}
	.plot-arrow { opacity: 0.7; }
	.plot .plot-note { font-size: 12px; border-bottom: 0; }

	/* ── controls: the world's ACTIVATE / PREVIEW family ── */
	.actions { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 34px; }
	.btn-activate {
		display: inline-block;
		background: var(--horizon-cta);
		color: var(--day);
		font-weight: 600;
		font-size: 15px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 13px 28px;
		border-radius: 999px;
		text-decoration: none;
		transition: transform 160ms ease, box-shadow 160ms ease, filter 160ms ease;
	}
	.btn-activate:hover { filter: brightness(1.12); transform: translateY(-2px); box-shadow: var(--shadow-raise); }
	.btn-preview {
		display: inline-block;
		background: transparent;
		color: inherit;
		border: 1px solid currentColor;
		font-weight: 500;
		font-size: 16px;
		padding: 13px 26px;
		border-radius: 10px;
		text-decoration: none;
		transition: background 160ms ease;
	}
	.btn-preview:hover { background: rgb(255 255 255 / 0.08); }

	.day-footer { position: relative; z-index: 1; background: var(--day); padding: 0 24px 56px; }
	.footer-inner {
		max-width: 780px;
		margin: 0 auto;
		padding-top: 18px;
		border-top: 1px solid var(--border);
		font-size: 13px;
		color: var(--ink-2);
	}
	.footer-inner a { color: var(--rose); text-underline-offset: 2px; }

	/* ── cue strip chrome ── */
	.cue-strip {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 10;
		height: var(--strip-h);
		display: flex;
		align-items: center;
		gap: 20px;
		padding: 0 20px;
		background: var(--night);
		border-bottom: 3px solid transparent;
		border-image: var(--horizon) 1;
	}
	.strip-brand {
		font-family: var(--font-cue);
		font-size: 15px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--day);
		text-decoration: none;
		flex: none;
	}
	.strip-cues {
		display: flex;
		gap: 4px;
		margin: 0 auto;
		overflow-x: auto;
		scrollbar-width: none;
		flex: 0 1 auto;
		min-width: 0;
		-webkit-mask-image: linear-gradient(90deg, #000 88%, transparent);
		mask-image: linear-gradient(90deg, #000 88%, transparent);
	}
	.strip-cues::-webkit-scrollbar { display: none; }
	.strip-cue {
		display: flex;
		gap: 7px;
		align-items: baseline;
		font-family: var(--font-cue);
		font-size: 11px;
		letter-spacing: 0.07em;
		color: #8d82a3;
		text-decoration: none;
		padding: 6px 9px;
		border-radius: 6px;
		font-variant-numeric: tabular-nums;
	}
	.strip-cue:hover { color: var(--day); }
	.strip-cue.current { color: var(--rose-light); background: color-mix(in srgb, var(--rose-light) 12%, transparent); }
	.strip-current {
		display: none;
		margin: 0 auto;
		min-width: 0;
		font-family: var(--font-cue);
		font-size: 12px;
		letter-spacing: 0.08em;
		color: var(--rose-light);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.strip-cta {
		background: var(--horizon-cta);
		color: var(--day);
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 7px 16px;
		border-radius: 999px;
		text-decoration: none;
		flex: none;
	}
	.strip-cta:hover { filter: brightness(1.12); }

	@media (max-width: 760px) {
		/* strip: one current-cue label instead of the undecodable digit row */
		.strip-cues { display: none; }
		.strip-current { display: block; }
		.sc-num { display: none; }
		.strip-brand,
		.strip-cta {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
		}
		/* plot: rule kind stacks above its row so cause never follows effect */
		.plot p { flex-wrap: wrap; gap: 6px 14px; }
		.plot-kind { flex-basis: 100%; min-width: 0; }
		.cue { min-height: 86vh; }
	}
</style>
