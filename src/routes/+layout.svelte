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
THESIS: The night shift as a stage lighting plot — every surface is a seamless cyclorama passing from blackout through cobalt and rose into white day while Moderaty clears the comments; refuses the gradient-hero SaaS landing and the shield-icon security look.
OWN-WORLD: cyc-black #050506 ground, cobalt horizon #0A2BFF, rose gather #024BFF, rose light #FF7BAE, dawn wash #FFD7E6, day #FFFFFF; Saira Stencil One cue caps with tabular numerals, Saira Condensed display, horizon bands as composition, ACTIVATE/PREVIEW controls.
STORY: A creator arrives dreading the unread pile, watches each cue of the night shift fire — rules, AI scoring, human queue — and connects their channel so morning is already clean.
FIRST VIEWPORT: depthless black, one low cobalt band rising, "Never read another hate comment." in condensed caps, ACTIVATE-pill CTA "Connect YouTube channel".
FORM: challenger stagecraft-theater-lighting-cyclorama-dawn, user-chosen over assigned Badge Zero; seed 1c2c971f.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->

{@render children()}
