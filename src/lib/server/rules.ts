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

import { checkSync } from 'recheck';

const RULE_TYPES = ['keyword', 'regex', 'user'] as const;
const RULE_ACTIONS = ['hold', 'reject', 'delete', 'ban'] as const;
const MAX_REGEX_PATTERN_LENGTH = 256;
const BACKREFERENCE_DIGIT = /[1-9]/;
const GROUP_PREFIX = /^\?(?:<[a-z][^>]*>|<?[=!:]|[-a-z]*:)/i;

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
	// Stryker disable next-line ArrayDeclaration: the sentinel is never popped — regex() compiles the pattern before unsafeRegex runs, so pops never exceed pushes for compilable patterns
	const starts: number[] = [];
	let escaped = false;
	let characterClass = false;
	// Stryker disable next-line EqualityOperator: `<=` only adds an iteration where charAt returns '', which matches no branch and is a no-op
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
			// Stryker disable next-line ConditionalExpression: unreachable — the pattern compiled in regex() before this runs, so every `)` pairs with a pushed `(`
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

function assertShape(rule: RuleRow): void {
	if (!RULE_TYPES.includes(rule.type as (typeof RULE_TYPES)[number])) {
		throw new Error(`rule #${rule.id} has an unsupported type: ${rule.type}`);
	}
	if (!RULE_ACTIONS.includes(rule.action as RuleAction)) {
		throw new Error(`rule #${rule.id} has an unsupported action: ${rule.action}`);
	}
	if (!rule.pattern) throw new Error(`rule #${rule.id} has an empty pattern`);
}

export function validateRule(rule: RuleRow): asserts rule is RuleRow & { type: (typeof RULE_TYPES)[number]; action: RuleAction } {
	assertShape(rule);
	if (rule.type === 'regex') regex(rule);
}

/** A validated rule with its regex (if any) compiled, ready for matching. */
export interface PreparedRule {
	rule: RuleRow & { type: (typeof RULE_TYPES)[number]; action: RuleAction };
	compiled: RegExp | null;
}

/**
 * Validates, compiles, and orders stored rules once so a batch of comments can
 * be matched without repeating the work. Shape validation happens before any
 * pattern length is dereferenced, each regex is compiled (and ReDoS-checked)
 * exactly once, and the most specific (longest) pattern sorts first, so
 * `fuck you` beats a stored `fuck` regardless of insertion order; ties keep
 * first-stored-wins.
 *
 * @throws If a stored rule is invalid.
 */
export function prepareRules(rules: RuleRow[]): PreparedRule[] {
	const prepared = rules.map((rule) => {
		assertShape(rule);
		const valid = rule as PreparedRule['rule'];
		return { rule: valid, compiled: rule.type === 'regex' ? regex(rule) : null };
	});
	prepared.sort((a, b) => b.rule.pattern.length - a.rule.pattern.length);
	return prepared;
}

/** Finds the prepared rule that matches the comment or its author. */
export function matchPreparedRule(text: string, authorChannelId: string, prepared: PreparedRule[]): PreparedRule['rule'] | null {
	const lower = text.toLowerCase();
	for (const { rule, compiled } of prepared) {
		if (rule.type === 'keyword' && lower.includes(rule.pattern.toLowerCase())) return rule;
		if (rule.type === 'user' && authorChannelId === rule.pattern) return rule;
		// nosemgrep: `compiled` only ever comes from regex() above, which rejects overly long,
		// backreferencing, duplicate-alternation, and recheck-unprovable patterns (I6).
		if (compiled?.test(text)) return rule;
	}
	return null;
}

/**
 * Finds the validated moderation rule that matches the comment or its author.
 * Prepares the rules for this single call; callers matching multiple comments
 * against the same rules should call `prepareRules` once and `matchPreparedRule`
 * per comment instead.
 *
 * @throws If a stored rule is invalid.
 */
export function matchRule(text: string, authorChannelId: string, rules: RuleRow[]): RuleRow | null {
	return matchPreparedRule(text, authorChannelId, prepareRules(rules));
}
