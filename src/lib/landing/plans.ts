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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

/**
 * Plan panel copy, shared by the homepage pricing section (short lists) and
 * the /pricing page (detailed lists). Billing-policy claims are limited to
 * what the product actually does: the hosted plan renews monthly, and all
 * top-up automation is opt-in and off by default.
 */
export const TICKS_SELF_HOSTED = [
	'Full rules engine and 13-category AI scoring',
	'Your key, your server, your data',
	'Audit log and dry-run mode included',
	'Fork it, audit it, trust no one'
];

export const TICKS_SELF_HOSTED_DETAILED = [
	'Full rules engine: KEYWORD, REGEX, and USER rules fire before the AI',
	'13-category AI scoring with your thresholds',
	'Review queue for the borderline',
	'Audit log: every action logged, every action reversible',
	'Dry-run mode: watch it work before it touches your channel'
];

export const TICKS_HOSTED = [
	'Auto-renews monthly, 100 comments included',
	'Top-ups in bundles of 100, 500, or 2,000 comments',
	'Automatic top-up is opt-in',
	'Same rules, same model, same audit log'
];

export const TICKS_HOSTED_DETAILED = [
	'Everything in self-hosted',
	'We run it, patch it, and keep it awake',
	'One-click YouTube OAuth',
	'100 comments a month; top up with comment bundles when you run out',
	'Automatic top-up is opt-in, off by default'
];

export const TICKS_LIFETIME = [
	'One payment, hosted forever',
	'We run the AI — no key to manage',
	'Unlimited moderated comments',
	'Only the first 1,000 users'
];

export const TICKS_LIFETIME_DETAILED = [
	'Everything in hosted, minus the monthly bill',
	'We run it, patch it, and keep it awake, forever',
	'No key to manage: we run the AI for you',
	'Unlimited moderated comments, no meter',
	'Capped at the first 1,000 users, then it is gone'
];
