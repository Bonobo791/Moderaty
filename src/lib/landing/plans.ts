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
 * what the product actually does: nothing renews, nothing auto-charges.
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
	'No subscription, nothing renews',
	'Same rules, same model, same audit log',
	'One-click YouTube OAuth'
];

export const TICKS_HOSTED_DETAILED = [
	'Everything in self-hosted',
	'We run it, patch it, and keep it awake',
	'One-click YouTube OAuth',
	'Top up only when you run out'
];
