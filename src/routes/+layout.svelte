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
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
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

{@render children()}
