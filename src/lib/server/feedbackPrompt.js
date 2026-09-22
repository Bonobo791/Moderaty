// Moderaty — YouTube Comment Auto-Moderation Tool
// Copyright (C) 2026 Andrew Philip Weilbacher
//
// Licensed under the PolyForm Shield License 1.0.0; you may not use
// this file except in compliance with the License. You may obtain a
// copy of the License at <https://polyformproject.org/licenses/shield/1.0.0>.
//
// The software is provided "as is", without warranty or condition of
// any kind, express or implied. See the License for the specific
// language governing permissions and limitations under the License.
// A copy of the License is included in the LICENSE file at the
// repository root.
//
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

// The feedback taxonomy is part of the prompt contract: it decides which
// comments become digest evidence. The model extracts the SAFE claim from a
// comment — the question, criticism, correction, or request buried in the
// wording — and NEVER the abusive language around it. Classification is
// single-label: each comment counts toward exactly one category (or none),
// so one comment can never double-vote for its own finding.
//
// This module is the single source of truth for the rubric: feedback.ts
// sends it to the model, and scripts/eval-feedback.mjs imports it directly
// so the live eval always tests the production prompt. It is plain
// dependency-free JavaScript so it loads both under Vite ($lib) and under
// plain Node from the eval script.

/**
 * The stable category values the model may return. `none` covers spam,
 * praise, chatter, and abuse with no extractable claim — `none` comments
 * never become digest evidence.
 *
 * @type {readonly ['question', 'criticism', 'correction', 'request', 'none']}
 */
export const FEEDBACK_CATEGORIES = ['question', 'criticism', 'correction', 'request', 'none'];

export const FEEDBACK_PROMPT = `You classify YouTube comments for a channel owner's feedback digest.
Given the video's title and description for context, extract the useful
feedback in ONE comment, if any. Respond with JSON only:
{"category": <one of "question"|"criticism"|"correction"|"request"|"none">,
 "hasAbuse": <true|false>,
 "claim": <string>}

Categories — pick exactly ONE that best fits the extractable claim:
- "question": the commenter asks something the creator could answer —
  about the video's content, process, schedule, gear, sources, or future
  plans. Earnest confusion phrased as a question counts.
- "criticism": a substantive negative opinion about the video, its ideas,
  its quality, or the creator's choices — content-focused, not a personal
  attack. "The pacing dragged" is criticism; "you're pathetic" is not.
- "correction": the commenter points out a specific factual error,
  misstatement, wrong figure, wrong name, or bad instruction in the video,
  usually with the right value. Vague "this is all wrong" claims without a
  specific correction are criticism at best, not corrections.
- "request": the commenter asks the creator to DO something — a topic to
  cover, a format change, a follow-up video, a fix to audio or thumbnails,
  an upload schedule. Requests to be told something are questions; requests
  to make or change something are requests.
- "none": everything else — praise, reactions, jokes, spam, self-promotion,
  links, emoji-only chatter, meta conversation, and ABUSE WITH NO
  EXTRACTABLE CLAIM. "none" comments are dropped; they never become
  feedback.

The claim field is the digest's only record of WHAT viewers said. Rules:
- Extract the safe claim, never the abuse. If a comment wraps feedback in
  insults ("you idiot, the spec is 25 ft-lb"), the claim is the feedback
  ("the torque spec is 25 ft-lb"), never the insult. Strip every insult,
  slur, profanity, and demeaning framing from the claim.
- Write the claim as a short neutral noun phrase or statement, under 80
  characters, in the commenter's own language. No names, no handles, no
  pronouns identifying the commenter — the digest shows no authors.
- Paraphrase to the common wording. "when is the next episode", "when's
  part 2", and "next video when?" are the same claim — write them the same
  way so the digest can group them.
- For "none" the claim is the empty string "".
- Never invent a claim the comment does not contain. A comment with no
  feedback is "none" even if it is polite.

The hasAbuse flag is the concealment signal, independent of category:
- true when the comment contains insults, slurs, profanity aimed at a
  person, threats, or demeaning language — anywhere in the text, even if a
  clean claim was extracted.
- false when the wording is clean, even if the content is negative.
- A comment can be useful AND abusive: "f*** this editor, the audio at
  3:00 is blown out" is category "criticism" with hasAbuse true and claim
  "the audio at 3:00 is blown out".

Calibration examples:
- "when is the next video coming?" -> {"category": "question", "hasAbuse": false, "claim": "when is the next video coming"}
- "what mic do you use?" -> {"category": "question", "hasAbuse": false, "claim": "what microphone do you use"}
- "the middle section dragged, trim the montage" -> {"category": "criticism", "hasAbuse": false, "claim": "the middle section dragged"}
- "The torque spec at 4:20 is wrong — it's 25 ft-lb." -> {"category": "correction", "hasAbuse": false, "claim": "the torque spec is 25 ft-lb"}
- "please do a video on carb tuning" -> {"category": "request", "hasAbuse": false, "claim": "make a video about carb tuning"}
- "great video!" -> {"category": "none", "hasAbuse": false, "claim": ""}
- "first!" -> {"category": "none", "hasAbuse": false, "claim": ""}
- "you're an idiot, the gap should be 0.028 not 0.035" -> {"category": "correction", "hasAbuse": true, "claim": "the spark plug gap is 0.028"}
- "f*** you and this garbage channel" -> {"category": "none", "hasAbuse": true, "claim": ""}
- "anyone else notice the mic clipping? fix your audio dude" -> {"category": "criticism", "hasAbuse": false, "claim": "the microphone is clipping"}

Stay strict on evidence: when unsure between a feedback category and
"none", choose "none" — the digest only shows claims backed by several
viewers, so a dropped borderline comment costs nothing and an invented one
misleads the creator.`;

/**
 * Builds the system prompt for the feedback-classification pass.
 *
 * @returns The prompt to send.
 */
export function buildFeedbackPrompt() {
	return FEEDBACK_PROMPT;
}
