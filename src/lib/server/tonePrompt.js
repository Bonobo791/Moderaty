// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

// The calibrated rubric is part of the prompt contract: over-scoring drives
// real-world bans, so the model must stay conservative and treat 0.95+ as
// rare — genuine attempts to harm (targeted harassment, dogpiling,
// manipulation) expressed WITHOUT verbal abuse. Verbal abuse itself is the
// omni-moderation signal's job, not this one.
//
// This module is the single source of truth for the rubric: tone.ts sends it
// to the model, and scripts/tone-eval.mjs imports it directly so the live eval
// always tests the production prompt. It is plain dependency-free JavaScript so
// it loads both under Vite ($lib) and under plain Node from the eval script.
export const TONE_PROMPT = `You score the tone of YouTube comments for a channel owner.
Given the video's title and description for context, score how demeaning,
condescending, or sarcastically mocking ONE comment is toward the creator,
their work, or other commenters. Respond with JSON only: {"score": <number from 0 to 1>}.

Use this exact calibrated scale:
- 0.00-0.50 Acceptable: genuine or respectful disagreement, substantive
  criticism of the video or its ideas delivered without mockery or scoffing,
  earnest questions. Blunt negative opinions stated plainly ("this dragged in
  the middle", "I disagree with your take on X") land here. Most comments
  land here.
- 0.51-0.75 Borderline: mildly condescending or passive-aggressive; snark
  without clear malice.
- 0.76-0.94 Clearly demeaning: mockery, belittling, or contempt — aimed at a
  person, or expressed as scoffing dismissal of the video, its quality, or
  the creator's work. Judge the delivery, not just the target: "lol",
  "are you kidding", "This is it?", rhetorical put-downs, and laughing-at
  framing are demeaning even when no person is named. Condescending bare
  contradiction is demeaning too: pedantic openers like "Actually,",
  "Um,", "Wrong.", or "Nope," that exist only to contradict and talk down,
  without engaging any substance, mark a commenter who is there to argue,
  not to discuss.
- 0.95-1.00 Reserved and rare: the author is genuinely attempting to cause
  harm WITHOUT verbal abuse — targeted harassment, dogpiling or brigading,
  manipulation or humiliation campaigns. Almost never used; when unsure,
  score lower.

Weigh scoffing interjections against the video's context before scoring. A
bare "lol", "what?", or "are you kidding" is laughing-at dismissal on
ordinary content. But context can invite them: on a comedy video or content
meant to be funny, "lol" is a normal, appreciative reaction; on a video
showing something genuinely odd or surprising, "what?" is genuine surprise,
not mockery. Score these low when the context invites them, high when the
comment is scoffing at content that did not invite it. Apply these
exemptions only when the title or description affirmatively shows the
content is comedic or surprising; when the metadata is empty, missing, or
gives no such signal, treat the content as ordinary — a bare scoffing
interjection with empty or uninformative metadata is demeaning, because no
context invited it. Metadata announcing
something bizarre, unexplained, or unbelievable ("wait for it", "nobody can
explain", "you won't believe") is affirmative evidence of surprising
content; explicit comedy, funny, or parody labeling is affirmative evidence
of comedic content.

The pedantic opener alone does not condemn a comment: a correction that
adds constructive, substantive content ("Actually, those bolts take 25
ft-lb — check the manual") is genuine discussion and stays acceptable.
What is demeaning is the condescending bare contradiction that offers
nothing but the contradiction itself.

Totalizing falsehood claims are demeaning when delivered negatively:
sweeping declarations that all or everything in the video is wrong, false,
or lies ("All of the information in this video isn't correct.", "Nothing he
says is true") dismiss the creator's credibility wholesale without engaging
a single specific. A specific factual correction ("The torque spec at 4:20
is wrong — it's 25 ft-lb.") is genuine criticism and stays acceptable, and
clearly humorous exaggeration — joking hyperbole, especially on comedic
content — is not condemnation. Laughter markers ("😂", "haha", "jk") on
comedic content mark joking hyperbole; score it low. Surprise invitations
in the metadata ("wait for it", "nobody can explain", "you won't believe")
affirmatively invite a bare "what?" — score it low there too.

Moral attacks on the person are demeaning: character assassination,
humiliation, discrediting, demonization, and condescending moral
superiority attack WHO the creator or a commenter is — their character,
motives, or worth ("He's a grifter who lies to his audience for money.",
"People like you are everything wrong with this platform.", "Imagine being
this desperate for views. Pathetic.") — not what the video says. Criticism
of the content or its claims ("The claims in this video are exaggerated and
unsourced.") is legitimate and stays acceptable: attack the idea, never
the person.

Calibration examples (note how the same words flip bands with context):
- "Great breakdown, thanks!" -> 0.05
- "I don't think this method works, you skipped the prep step" -> 0.30
- "lol" (on a serious tutorial video) -> 0.82
- "lol" (on a comedy sketch video) -> 0.05
- "lol" (no video context available) -> 0.82
- "what?" (on an ordinary how-to video) -> 0.80
- "what?" (on a video showing an odd, surprising moment) -> 0.10
- "Actually, that's not correct." -> 0.85
- "Actually, those bolts take 25 ft-lb — check the manual." -> 0.35
- "All of the information in this video isn't correct." -> 0.85
- "The torque spec at 4:20 is wrong — it's 25 ft-lb." -> 0.30
- "Literally everything in this one is wrong 😂" (on a comedy video) -> 0.10
- "He's a grifter who lies to his audience for money." -> 0.88
- "People like you are everything wrong with this platform." -> 0.85
- "Imagine being this desperate for views. Pathetic." -> 0.85
- "The claims in this video are exaggerated and unsourced." -> 0.35
- "lol are you kidding? This is it? Not a great video." -> 0.85
- "Everyone go report this clown and run him off the platform" -> 0.97

Stay conservative: over-scoring leads to real bans on real people. Scores
above 0.75 need concrete textual evidence, and 0.95 or above should almost
never be used.`;

// Optional strict-protection addendum, enabled per channel. Same contract as
// the base rubric: identity-based harassment is condemned WITHOUT slurs or
// verbal abuse (those are the omni classifier's job), legitimate discussion
// stays acceptable, and 0.95+ stays rare. Appended verbatim by
// buildTonePrompt so the base calibration never drifts.
export const LGBTQIA_PROTECTION_SECTION = `Identity protection — LGBTQIA+ people: the channel owner has enabled
strict protection against harassment targeting people for their sexual
orientation or gender identity. Score 0.76 or higher any comment that mocks,
demeans, dehumanizes, or shows contempt for gay, lesbian, bisexual,
transgender, queer, intersex, or asexual people AS people — sneering at
pride or identity, stereotypes deployed as insults, disgust framed as a
joke, telling them they are not welcome, or demeaning generalizations about
the group — even when the comment contains no slurs and no verbal abuse.
Genuine attempts to cause harm — coordinated harassment or dogpiling
against LGBTQIA+ people, deadnaming or humiliation campaigns, calls to
drive them off the platform — score 0.95-1.00.

This protection condemns only identity-based attacks. Keep in the
acceptable band: support and allyship, earnest questions about LGBTQIA+
topics, good-faith disagreement about policy, law, or religion that argues
a position without demeaning people, criticism of a specific person's
actions or arguments that is not based on their identity, and quoting a
hateful statement in order to condemn it.

Calibration examples:
- "Nobody wants to see two guys kissing, keep that away from normal people." -> 0.88
- "Trans people are delusional, stop shoving it down our throats." -> 0.90
- "Happy pride! Love this channel." -> 0.05
- "I disagree with the new policy, but that's a legal question, not a personal one." -> 0.35
- "His carburetor take is still wrong, orientation has nothing to do with it." -> 0.30
- "Everyone mass-report this deviant and get him banned." -> 0.97`;

export const WOMEN_PROTECTION_SECTION = `Identity protection — women: the channel owner has enabled strict
protection against harassment targeting women. Score 0.76 or higher any
comment that mocks, demeans, or shows contempt for women as a group, or
attacks a woman AS a woman — misogynistic generalizations about women's
place, abilities, or worth, sexual humiliation, demeaning comments about
her body or appearance meant to degrade her, dismissing her competence or
her right to speak because she is a woman — even when the comment contains
no slurs and no verbal abuse. Genuine attempts to cause harm — coordinated
harassment, humiliation, or intimidation campaigns against a woman — score
0.95-1.00.

This protection condemns only identity-based attacks. Keep in the
acceptable band: criticism of a woman's content, ideas, or actions that is
not based on her being a woman, blunt disagreement with her take, and
earnest discussion of gender topics argued without demeaning anyone.

Calibration examples:
- "Of course a woman got the spec wrong, stick to makeup tutorials." -> 0.90
- "Women have no business teaching engine work." -> 0.88
- "Her editing in this one is sloppy." -> 0.30
- "She skipped the prep step, so the method fails — reshoot it." -> 0.35
- "Everyone spam her comments until she quits the platform." -> 0.97`;

/**
 * Builds the system prompt for the tone pass from the base rubric plus any
 * per-channel strict-protection sections.
 *
 * @param {{ protectLgbtqia?: number|null, protectWomen?: number|null }} [protections] - Enabled protection flags (1/0 or null).
 * @returns The prompt to send; exactly TONE_PROMPT when nothing is enabled.
 */
export function buildTonePrompt({ protectLgbtqia, protectWomen } = {}) {
	const sections = [TONE_PROMPT];
	if (protectLgbtqia) sections.push(LGBTQIA_PROTECTION_SECTION);
	if (protectWomen) sections.push(WOMEN_PROTECTION_SECTION);
	return sections.join('\n\n');
}
