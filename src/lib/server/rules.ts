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

import { checkSync } from 'recheck';

const RULE_TYPES = ['keyword', 'regex', 'user'] as const;
const RULE_ACTIONS = ['hold', 'reject', 'delete', 'ban'] as const;
const MAX_REGEX_PATTERN_LENGTH = 256;
const BACKREFERENCE_DIGIT = /[1-9]/;
const GROUP_PREFIX = /^\?(?:<[a-zA-Z][^>]*>|<?[=!:]|[-a-z]*:)/i;

export type RuleAction = (typeof RULE_ACTIONS)[number];

export interface RuleRow {
	id: number;
	type: string;
	pattern: string;
	action: string;
}

/**
 * Detects exact duplicate top-level alternatives in a group body (e.g. `a|a`).
 * recheck deduplicates identical branches during analysis and reports patterns
 * such as `(a|a)+` safe, even though backtracking engines explore both branches
 * exponentially, so this blind spot is covered here.
 */
function duplicateAlternation(body: string): boolean {
	const alternatives = new Set<string>();
	let depth = 0;
	let escaped = false;
	let characterClass = false;
	let start = 0;
	for (let index = 0; index <= body.length; index++) {
		const character = body[index];
		if (index < body.length) {
			if (escaped) {
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
				depth++;
				continue;
			}
			if (character === ')') {
				depth--;
				continue;
			}
			if (character !== '|' || depth > 0) continue;
		}
		const alternative = body.slice(start, index);
		if (alternatives.has(alternative)) return true;
		alternatives.add(alternative);
		start = index + 1;
	}
	return false;
}

/** Rejects backreferences (`\1`–`\9`, `\k<name>`) and groups with duplicate alternatives. */
function unsafeSyntax(pattern: string): boolean {
	const starts: number[] = [];
	let escaped = false;
	let characterClass = false;
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern.charAt(index);
		if (escaped) {
			if (BACKREFERENCE_DIGIT.test(character) || (character === 'k' && pattern[index + 1] === '<')) return true;
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
			starts.push(index);
			continue;
		}
		if (character === ')') {
			const start = starts.pop();
			if (start === undefined) continue; // unbalanced: new RegExp reports the pattern invalid
			// Strip the group prefix (`?:`, `?=`, `?!`, `?<=`, `?<!`, `?<name>`, `?flags:`) before comparing alternatives.
			const body = pattern.slice(start + 1, index).replace(GROUP_PREFIX, '');
			if (duplicateAlternation(body)) return true;
		}
	}
	return false;
}

function unsafeRegex(pattern: string): boolean {
	if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return true;
	if (unsafeSyntax(pattern)) return true;
	try {
		// 'unknown' means recheck could not prove the pattern safe; reject it loudly rather than risk ReDoS.
		return checkSync(pattern, 'i').status !== 'safe';
	} catch (error) {
		console.warn(`recheck could not analyze a rule pattern; rejecting it as unsafe:`, error);
		return true;
	}
}

function regex(rule: RuleRow): RegExp {
	let compiled: RegExp;
	try {
		// nosemgrep: unsafeRegex below rejects overly long, backreferencing, duplicate-alternation, and ReDoS-prone patterns.
		compiled = new RegExp(rule.pattern, 'i');
	} catch (error) {
		throw new Error(`rule #${rule.id} has an invalid regex: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (unsafeRegex(rule.pattern)) throw new Error(`rule #${rule.id} has an unsafe regex`);
	return compiled;
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
