<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher
#
# Licensed under the PolyForm Shield License 1.0.0; you may not use
# this file except in compliance with the License. You may obtain a
# copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
#
# The software is provided "as is", without warranty or condition of
# any kind, express or implied. See the License for the specific
# language governing permissions and limitations under the License.
# A copy of the License is included in the LICENSE file at the
# repository root.
#
# Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
-->
---
name: Moderaty
description: Comment protection for YouTube creators — the night shift as a stage lighting plot.
colors:
  night: "#050506"
  cobalt: "#0a2bff"
  rose: "#024bff"
  rose-light: "#ff7bae"
  dawn: "#ffd7e6"
  day: "#ffffff"
  operate-bg: "#fbfafd"
  operate-border: "#e9e2f1"
  ink: "#17121f"
  ink-2: "#5f566d"
  brand-soft: "#e9ecff"
  held-soft: "#e4e9ff"
  danger: "#cf1f5c"
  danger-soft: "#ffe9f1"
  dawn-soft: "#fff3f8"
  night-prose: "#e7e0f3"
  night-fine: "#efe9f8"
  night-dim: "#9a8fb0"
  day-prose: "#463e55"
typography:
  display:
    fontFamily: "'Saira Condensed', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(2.8rem, 8.5vw, 5.75rem)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "0.005em"
  headline:
    fontFamily: "'Saira Condensed', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "clamp(2rem, 5.5vw, 3.6rem)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "0.005em"
  title:
    fontFamily: "'Saira Condensed', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.01em"
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    lineHeight: 1.55
  prose:
    fontFamily: "'Saira', system-ui, sans-serif"
    fontSize: "17px"
    lineHeight: 1.65
  cue:
    fontFamily: "'Saira Stencil One', 'Saira Condensed', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    letterSpacing: "0.08em"
    fontFeature: "tabular-nums"
rounded:
  sm: "8px"
  md: "12px"
  pill: "999px"
spacing:
  sm: "8px"
  md: "14px"
  lg: "24px"
  xl: "48px"
components:
  button-activate:
    backgroundColor: "linear-gradient(90deg, {colors.cobalt}, {colors.rose} 50%, #c22b6b)"
    textColor: "{colors.day}"
    rounded: "{rounded.pill}"
    padding: "13px 28px"
  button-secondary:
    backgroundColor: "{colors.day}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "8px 20px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.day}"
    rounded: "{rounded.pill}"
    padding: "8px 20px"
  button-preview:
    backgroundColor: "transparent"
    textColor: "inherit"
    rounded: "10px"
    padding: "13px 26px"
  card:
    backgroundColor: "{colors.day}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "20px"
  badge:
    backgroundColor: "{colors.held-soft}"
    textColor: "{colors.rose}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  input:
    backgroundColor: "{colors.day}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
---

# Design System: Moderaty

## Overview

**Creative North Star: "The Cyclorama Cue Sheet"**

Moderaty renders the product's promise — the night's comments cleared before
morning — as a stage lighting plot. The landing page is one seamless cyclorama:
a depthless cyc-black ground (`#050506`) with a low cobalt horizon, rose
gathering above it, a dawn wash, and finally white day, scrolled through cue by
cue (LX-00 STANDBY → LX-05 DAY). Each section is one lighting cue of the night
shift, tagged in Saira Stencil cue caps with timecodes. The world refuses the
gradient-hero SaaS landing and the shield-icon security look; protection is
told as a lighting sequence, not a badge.

The system runs in two registers. **Persuade** (the landing) lives on the night
side of the cyc: dark ground, white and lavender prose, stencil cue tags,
horizon bands as composition. **Operate** (dashboard, rules, queue, log) is the
light side: a near-white work surface (`#fbfafd`), white cards, quiet borders,
compact 15px type — because the drama is deliberately over by the time the
creator opens the app. The night nav bar with its 3px horizon border-image is
the one piece of the cyc that crosses into the operate register.

Density is calm and readable on the landing (62ch measure, generous air),
workmanlike in the app (14–15px, 900px column, tables with tabular numerals).

**Key Characteristics:**
- One vertical color story: night → cobalt → rose → dawn → day; surfaces pick a phase, they don't mix them.
- Stencil cue caps with tabular numerals as the world's signature label voice.
- ACTIVATE pills carry the only multi-color gradient allowed on a control; everything else is flat.
- Every page ships all four states: loading skeleton, dashed-border empty state, tinted error box, populated content.

## Colors

The palette is a lighting plot read vertically: darkness at the bottom, one
saturated horizon, warmth gathering, white day at the top. Blues and pinks are
the whole family; there is no green and no neutral gray that isn't violet-leaning.

### Primary
- **Cobalt Horizon** (#0a2bff): the brand accent and the bottom of the horizon. Links and focus outlines in the operate register (`--brand`), the start of every gradient, hover-lift shadow tint.
- **Rose Gather** (#024bff): the horizon's second stop and the "held" semantic — default badge text. (The name is theatrical: the value is a blue that reads rose in sequence against cobalt.)

### Secondary
- **Rose Light** (#ff7bae): the first genuinely pink step. Current-cue highlight on the cue strip, monitor readouts on night sections, the warm end of the decorative horizon.
- **Dawn Wash** (#ffd7e6): the pre-day phase of the cyc; also the conceptual source of the dawn-tinted surfaces below.

### Tertiary
- **Deepened Rose** (#c22b6b): exists only as the end stop of the CTA gradient, chosen so white cue-caps labels keep ≥4.5:1 contrast across the whole pill.
- **Readable Crimson** (#cf1f5c): the danger semantic — rose light deepened until it passes on white. Reject/delete/ban actions, error boxes, danger badges.

### Neutral
- **Cyc Black** (#050506): the night ground; landing background, app nav bar.
- **Day White** (#ffffff): the end of the plot; also every card and input surface in the operate register.
- **Operate Ground** (#fbfafd): the near-white app background — day with one degree of violet.
- **Stage Ink** (#17121f) and **Ink Two** (#5f566d): text and secondary text in the operate register; both lean violet, never pure gray.
- **Night Prose** (#e7e0f3), **Night Fine** (#efe9f8), **Night Dim** (#9a8fb0): the landing's night-phase text scale — paragraphs, fine print, and muted notes on dark grounds; all three pass ≥4.5:1 only on night/cobalt, never on the rose gather.
- **Day Prose** (#463e55): landing prose on dawn and day grounds.
- **Gel Border** (#e9e2f1): card, table, input, and empty-state borders.
- **Soft tints** — brand-soft (#e9ecff), held-soft (#e4e9ff), danger-soft (#ffe9f1), dawn-soft (#fff3f8): the tint that pairs with each saturated semantic for badges, flash/error boxes, code chips, and quote blocks.

### Named Rules
**The Two Registers Rule.** Persuade surfaces use the night side (cyc black ground, light text); operate surfaces use the light side (near-white ground, dark ink). The nav bar is the only element allowed to carry cyc black into the app. Never put a dark section inside an operate page or a white card on the landing.

**The Horizon Rule.** Multi-color gradients appear in exactly two forms: the decorative horizon (`--horizon`, cobalt → rose → rose-light) as border-image strips and full-bleed phase bands, and the CTA horizon (`--horizon-cta`) on activate controls. Never a free-floating purple mesh, never a gradient on a card.

**The Daylight Contrast Rule.** Any control that takes white text over the horizon uses `--horizon-cta`, whose rose end is deepened to #c22b6b. The decorative `--horizon` is for surfaces and borders only.

**The Phase-Text Rule.** Text color follows the ground's phase, never habit. Night-phase small accents (cue-tag numerals, plot kinds) use Dawn Wash (#ffd7e6) — the paler pinks fail on cobalt. Day-phase cue tags and timecodes use Stage Ink (#17121f), because brand blues and roses fail on the dawn/pink grounds. Verify every text/ground pair against the live sky, not the static band: the sky's violet stretch (cobalt 45% → #5a4fd6 64%) keeps the LX-03 text block on dark ground before the rose peak at 70%.

## Typography

**Display Font:** Saira Condensed (500–700, self-hosted woff2)
**Body Font:** system stack in the operate register; Saira variable for landing prose (self-hosted, weight axis 100–900)
**Label/Cue Font:** Saira Stencil One (400, self-hosted) — the cue-caps voice

**Character:** a theater lighting console annotated by hand — condensed
all-caps headlines doing the projecting, a warm humanist sans for the actual
reading, and stencil cue caps reserved for tags, timecodes, and the wordmark.
All three faces are self-hosted from `static/fonts/`; there are no webfont
services.

### Hierarchy
- **Display** (700, clamp(2.8rem, 8.5vw, 5.75rem), 1.02, uppercase, balanced wrap): the hero promise on LX-00. Landing only.
- **Headline** (700, clamp(2rem, 5.5vw, 3.6rem), 1.02, uppercase): one per cue section; also card titles in-app at inherited size.
- **Title** (600, 26px, 1.2): operate-register page headings (`h1` in the app shell), Saira Condensed, not uppercased by the global rule.
- **Body** (400, 15px, 1.55): operate register default.
- **Prose** (400, 17px, 1.65, Saira, max 62ch): landing paragraphs; lede bumps to 21px/500, fine print drops to 14px.
- **Cue Label** (400, 11–15px, letter-spacing 0.06–0.1em, tabular-nums, uppercase): cue tags, timecodes, monitor readouts, cue-strip items, table header cells (Condensed 12px/0.1em plays the same role in-app), the Moderaty wordmark.

### Named Rules
**The Cue Caps Rule.** Saira Stencil One speaks only in short uppercase labels — cue tags, timecodes, counters, the wordmark. Never body copy, never a headline, never mixed case. Numbers under it always use tabular-nums.

**The Condensed Projector Rule.** Headlines are Saira Condensed at 600–700; on the landing they are uppercase with near-zero letter-spacing (0.005em) and line-height 1.02. Weight 700 is for projecting across the room; operate titles step down to 600.

## Layout

Two spatial models, matching the two registers. The landing is a sequence of
full-viewport cues: each section ≥92vh (86vh under 760px), content centered in
a 780px column with prose capped at 62ch, a fixed 56px cue strip on top
carrying the wordmark, six cue anchors, and a compact Connect CTA. An
IntersectionObserver tracks the active cue; with motion welcome, one 520vh
gradient sky translates behind transparent sections, and without JS or under
reduced-motion each section's own static horizon band carries the same story —
the composition is never allowed to depend on the animation. The cues sit in a
`<main>` landmark; the footer is a top-level `contentinfo` on day white after
it (PolyForm / self-host / commercial-licensing links in rose), stacked above the
fixed sky (`z-index: 1`) like every cue.

The operate register is a single 900px column (`margin: 32px auto`, 20px side
padding) under a 56px night nav. Rhythm is compact and even: cards pad 20px and
stack at 14px, page subs sit 24px above content, primary actions precede
lists. Tables run full column width with 10px/8px cell padding and no outer
chrome.

## Elevation & Depth

The system is flat at rest. Depth on the landing is staged with light (phase
bands, the rising sky), not shadow; the operate register uses one quiet ambient
shadow on cards and a lift that exists only as a hover response on activate
buttons. Nothing floats by default.

### Shadow Vocabulary
- **Card ambient** (`box-shadow: 0 1px 2px rgb(23 18 31 / 0.07), 0 6px 16px rgb(23 18 31 / 0.06)`): the only resting shadow; white cards over the operate ground.
- **Cue lift** (`box-shadow: 0 2px 4px rgb(23 18 31 / 0.1), 0 10px 24px rgb(2 75 255 / 0.16)`): hover state of activate pills — the glow leaks rose, as if the button were lit from below.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat; the only resting elevation is the card ambient. Shadows appear as a response to hover and never as decoration. No hard offset shadows anywhere — depth is staged with color phases, not drop shadows.

## Shapes

Two corner languages, each with a fixed job. Pills (999px) are for controls and
badges — anything you press or read as a status. Soft rectangles (8px small,
12px large) are for containers and fields — cards, inputs, quotes, state boxes,
skeletons, and the PREVIEW secondary button (10px). The landing's horizon bands
are straight full-bleed edges; there are no clipped diagonals, blobs, or
asymmetric masks beyond the cue strip's horizontal fade. Borders are 1px in the
violet-tinted Gel Border, dashed only for empty states.

## Components

### Buttons (the ACTIVATE / PREVIEW family)
- **Shape:** full pill (999px) for primary/secondary/danger; the ghost PREVIEW variant keeps a 10px soft rectangle with a 1px currentColor border.
- **Activate:** CTA horizon gradient, white 600-weight label, 13px 28px (landing) or 8px 20px (in-app `.btn`); landing instance uppercases at 0.05em. Hover brightens (filter 1.12), lifts 1–2px, and fires the cue-lift shadow; active settles back.
- **Secondary:** white surface, ink label, 1px Gel Border, 500 weight; hover fades to the operate ground with no lift, no shadow.
- **Danger:** Readable Crimson fill, deepening on hover (#a81448); no brightness filter.
- **Small:** 5px 12px at 13px for in-card actions.
- **Focus:** 2px cobalt outline, 2px offset, on every interactive element; rose-light inside the night nav and the landing cue strip (cobalt fails 3:1 on cyc black).

### Badges
- **Style:** pill, 2px 10px, 12px/500, tabular-nums. Default is the held pairing (held-soft ground, rose text) — the queue's "waiting" tone.
- **Variants:** neutral (gray-violet), ok (cobalt on brand-soft), attention (crimson on danger-soft), danger (crimson on danger-soft). Attention and danger share the crimson pairing but carry different semantics: **attention = a human decision is needed** (pending counts, queued items), **danger = a destructive action was taken** (reject/delete/ban in the log). A settled outcome (rejected/deleted counts on the dashboard) is neutral, not danger — the alarm color is reserved for what still needs you.
- **Rule:** a badge is always a soft tint under its saturated ink, never a saturated fill with white text.

### Cards / Containers
- **Corner Style:** gently rounded (12px).
- **Background:** Day White over the operate ground.
- **Shadow Strategy:** card ambient only (see Elevation).
- **Border:** 1px Gel Border.
- **Internal Padding:** 20px; stacked at 14px.

### Inputs / Fields
- **Style:** 1px Gel Border on white, 8px radius, 8px 10px padding, 14px.
- **Focus:** border switches to cobalt with a 3px brand-soft halo; the outline rule above also applies to focus-visible.
- **Error:** form-level errors surface in the error box, not per-field chrome.

### Navigation
- **Cue strip (landing):** fixed 56px bar on cyc black, 3px horizon border-image along the bottom edge. Stencil wordmark, six stencil cue anchors (numeral + name) that highlight rose-light on a 12% rose-light ground when current, compact activate CTA at the end. Under 760px the anchor row gives way to a single current-cue label (the active cue's name, tracking scroll) — and the strip's touch targets step up to 44px.
- **App nav (operate):** the same 56px night bar and horizon edge — the world's one dark element in the light register — with lavender links (#c9bed6) that go white on hover.

### Lighting plot (signature)
Landing rule/threshold lists render as a cue sheet: a top rule line, rows of
stencil cue-kind labels (KEYWORD / ≥ 0.95) against their action, separated by
28%-alpha currentColor hairlines, numerals always tabular. This is how the
world shows a list of consequences — reuse it for any landing enumeration.

### States (invariant I12)
- **Skeleton:** 8px-radius shimmer bar, lavender gradient sliding at 1.2s; animation off under reduced-motion.
- **Empty:** centered, 48px 24px, dashed Gel Border, 12px radius, ink title over muted hint.
- **Error box:** danger-soft ground, 1px #f6b8cd border, crimson text, 8px radius.
- **Flash:** brand-soft ground, 1px #b9c4ff border, cobalt text — the affirmative counterpart.

## Do's and Don'ts

### Do:
- **Do** pick a phase of the plot per surface and stay in it — night surfaces take light text (#e7e0f3 prose), day surfaces take ink (#463e55 prose).
- **Do** use the CTA horizon (`--horizon-cta`, ending #c22b6b) for any control bearing white text; reserve the decorative horizon for borders and bands.
- **Do** set cue tags, counters, and timecodes in Saira Stencil One with tabular-nums and 0.06–0.1em tracking.
- **Do** ship all four states (skeleton, dashed empty, tinted error, populated) on every data surface.
- **Do** keep the operate register quiet: white cards, 1px violet-tinted borders, one ambient shadow, compact 14–15px type.
- **Do** honor `prefers-reduced-motion`: the static per-cue horizon bands must carry the full story on their own.

### Don't:
- **Don't** invent new hues — the palette is cobalt/rose/dawn against near-black and near-white; no green success fills, no amber warnings (ok = cobalt, danger = deepened rose).
- **Don't** put gradients on cards, badges, or inputs, and never a generic purple mesh; gradients exist only as horizon bands, the 3px nav edge, and activate pills.
- **Don't** set body copy or headlines in Saira Stencil One, and never set cue labels in lowercase.
- **Don't** use hard offset drop shadows or floating elevated chrome; depth is staged with color phases.
- **Don't** use glyph/icon fonts or a shield motif — the world speaks in cue numbers and horizon bands.
- **Don't** clamp or abbreviate the cue sequence; the landing's story is the ordered LX-00 → LX-05 arc.
