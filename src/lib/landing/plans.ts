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
	'Top-ups at 5¢ a comment, any amount',
	'Automatic top-up is opt-in',
	'Same rules, same model, same audit log'
];

export const TICKS_HOSTED_DETAILED = [
	'Everything in self-hosted',
	'We run it, patch it, and keep it awake',
	'One-click YouTube OAuth',
	'100 comments a month; top up at 5¢ when you run out',
	'Automatic top-up and balance auto-charge are opt-in, off by default'
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
