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

const RULE_TYPES = ['keyword', 'regex', 'user'] as const;
const RULE_ACTIONS = ['hold', 'reject', 'delete', 'ban'] as const;
const MAX_REGEX_PATTERN_LENGTH = 256;

export type RuleAction = (typeof RULE_ACTIONS)[number];

export interface RuleRow {
	id: number;
	type: string;
	pattern: string;
	action: string;
}

function quantifier(character: string | undefined): boolean {
	return character === '*' || character === '+' || character === '?' || character === '{';
}

function unsafeRegex(pattern: string): boolean {
	if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return true;
	const groups: boolean[] = [];
	let escaped = false;
	let characterClass = false;
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index]!;
		if (escaped) {
			if (/[1-9]/.test(character)) return true;
			escaped = false;
			continue;
		}
		if (character === '\\') {
			escaped = true;
			continue;
		}
		if (character === '[') {
			characterClass = true;
			continue;
		}
		if (character === ']') {
			characterClass = false;
			continue;
		}
		if (characterClass) continue;
		if (character === '(') {
			groups.push(false);
			continue;
		}
		if (character === ')') {
			const containsQuantifier = groups.pop() ?? false;
			if (containsQuantifier && quantifier(pattern[index + 1])) return true;
			if (containsQuantifier && groups.length) groups[groups.length - 1] = true;
			continue;
		}
		if (quantifier(character) && pattern[index - 1] !== '(' && groups.length) {
			groups[groups.length - 1] = true;
		}
	}
	return false;
}

function regex(rule: RuleRow): RegExp {
	if (unsafeRegex(rule.pattern)) throw new Error(`rule #${rule.id} has an unsafe regex`);
	try {
		// nosemgrep: unsafeRegex rejects bounded, backreferencing, and nested-quantifier patterns.
		return new RegExp(rule.pattern, 'i');
	} catch (error) {
		throw new Error(`rule #${rule.id} has an invalid regex: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function validateRule(rule: RuleRow): asserts rule is RuleRow & { type: (typeof RULE_TYPES)[number]; action: RuleAction } {
	if (!RULE_TYPES.includes(rule.type as (typeof RULE_TYPES)[number])) {
		throw new Error(`rule #${rule.id} has an unsupported type: ${rule.type}`);
	}
	if (!RULE_ACTIONS.includes(rule.action as RuleAction)) {
		throw new Error(`rule #${rule.id} has an unsupported action: ${rule.action}`);
	}
	if (!rule.pattern) throw new Error(`rule #${rule.id} has an empty pattern`);
	if (rule.type === 'regex') regex(rule);
}

/**
 * Finds the first validated moderation rule that matches the comment or its author.
 *
 * @throws If a stored rule is invalid.
 */
export function matchRule(text: string, authorChannelId: string, rules: RuleRow[]): RuleRow | null {
	rules.forEach(validateRule);
	const lower = text.toLowerCase();
	for (const rule of rules) {
		if (rule.type === 'keyword' && lower.includes(rule.pattern.toLowerCase())) return rule;
		if (rule.type === 'user' && authorChannelId === rule.pattern) return rule;
		if (rule.type === 'regex' && regex(rule).test(text)) return rule;
	}
	return null;
}
