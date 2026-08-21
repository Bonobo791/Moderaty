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
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';

	let { children, data } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<!--
THESIS: The night shift, in terminal ink — a dark, mono-driven page where the product visibly does its job; one hot banhammer-pink accent is the hammer, verdict stamps, and primary CTA. Refuses the gradient-hero SaaS landing and the shield-icon security look.
OWN-WORLD: ink #0B0B14 canvas, surface #12121E, hairline #23233A, paper #F4F4F8 at an opacity ladder; banhammer pink #EF2D5E, verdict semantics mint #3ECF8E / amber #F5B84C; Archivo (variable, Expanded for stats) display, IBM Plex Mono terminal register; corner-bracketed panels, radius-0 stamps, pill only on the primary CTA.
STORY: A creator arrives dreading the unread pile, watches the Bonk Queue judge a scripted night — rules, AI scoring, human queue — meets the regulars, and connects their channel so morning is already clean.
FIRST VIEWPORT: asymmetric split — eyebrow, "Never read another hate comment." with a marker-highlighted punch, connect CTA left; the live Bonk Queue panel right, verdicts stamping in as comments arrive.
FORM: terminal-ink night shift; live component as hero visual, verdict stamps as the only decoration.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->

<LanguageSwitcher locale={data.locale ?? 'en'} />
{@render children()}
