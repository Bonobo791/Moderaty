import { BackupError } from './common.mjs';
const invalid = () => { throw new BackupError('validation', 'Unsupported or malformed SQL syntax.'); };

// SQLite-aware token boundaries. Comments and strings are not keywords; never
// use line/regex deletion on dump data (a string can contain whole SQL lines).
export function sqlTokens(sql) {
	const tokens = []; let i = 0;
	while (i < sql.length) {
		if (/\s/.test(sql[i])) { i++; continue; }
		if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue; }
		if (sql.startsWith('/*', i)) { const end = sql.indexOf('*/', i + 2); if (end < 0) invalid(); i = end + 2; continue; }
		const start = i; const quote = sql[i];
		if (["'", '"', '`', '['].includes(quote)) {
			const endQuote = quote === '[' ? ']' : quote; let value = ''; i++; let closed = false;
			while (i < sql.length) {
				if (sql[i] === endQuote) {
					if (quote !== '[' && sql[i + 1] === endQuote) { value += endQuote; i += 2; continue; }
					i++; closed = true; break;
				}
				value += sql[i++];
			}
			if (!closed) invalid();
			tokens.push({ kind: quote === "'" ? 'literal' : 'identifier', value, start, end: i });
		} else if (/[A-Za-z0-9_$]/.test(quote)) {
			while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
			tokens.push({ kind: 'word', value: sql.slice(start, i).toLowerCase(), start, end: i });
		} else {
			i++; tokens.push({ kind: 'punctuation', value: quote, start, end: i });
		}
	}
	return tokens;
}
export function canonical(tokens) {
	return JSON.stringify(tokens.map((t) => [t.kind === 'literal' ? 'literal' : 'sql', t.kind === 'literal' ? t.value : t.value.toLowerCase()]));
}
export function checkExpressions(sql) {
	const tokens = sqlTokens(sql); const checks = [];
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].kind !== 'word' || tokens[i].value !== 'check' || tokens[i + 1]?.value !== '(') continue;
		let depth = 1; const start = i + 2; i += 2;
		for (; i < tokens.length; i++) {
			if (tokens[i].kind !== 'punctuation') continue;
			if (tokens[i].value === '(') depth++;
			if (tokens[i].value === ')' && --depth === 0) break;
		}
		if (depth) invalid(); checks.push(canonical(tokens.slice(start, i)));
	}
	return { checks, autoIncrement: tokens.some((t) => t.kind === 'word' && t.value === 'autoincrement') };
}
function isScalar(tokens) {
	if (tokens.length === 1 && (tokens[0].kind === 'literal' || (tokens[0].kind === 'word' && tokens[0].value === 'null'))) return true;
	if (tokens.length === 2 && tokens[0].kind === 'word' && tokens[0].value === 'x' && tokens[1].kind === 'literal' && tokens[0].end === tokens[1].start) return /^(?:[0-9a-f]{2})*$/i.test(tokens[1].value);
	return tokens.every((t, i) => ['word', 'punctuation'].includes(t.kind) && (i === 0 || tokens[i - 1].end === t.start)) && /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$/.test(tokens.map((t) => t.value).join(''));
}
function isStatistics(statement) {
	const word = (i, value) => statement[i]?.kind === 'word' && statement[i].value === value;
	const name = statement[2]?.value.toLowerCase();
	if (!(word(0, 'insert') && word(1, 'into') && ['identifier', 'word'].includes(statement[2]?.kind) && /^sqlite_stat[1-4]$/.test(name ?? ''))) return false;
	if (!word(3, 'values') || statement[4]?.kind !== 'punctuation' || statement[4]?.value !== '(' || statement.at(-2)?.kind !== 'punctuation' || statement.at(-2)?.value !== ')' || statement.at(-1)?.value !== ';') invalid();
	const values = []; let current = [];
	for (const token of statement.slice(5, -2)) {
		if (token.kind === 'punctuation' && token.value === ',') { values.push(current); current = []; }
		else current.push(token);
	}
	values.push(current);
	const arity = { sqlite_stat1: 3, sqlite_stat2: 4, sqlite_stat3: 6, sqlite_stat4: 6 }[name];
	if (values.length !== arity || !values.every(isScalar)) invalid();
	return true;
}
export function withoutOptimizerStatistics(sql) {
	const tokens = sqlTokens(sql); const retained = []; let start = 0; let first = 0;
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].kind !== 'punctuation' || tokens[i].value !== ';') continue;
		const statement = tokens.slice(first, i + 1); const values = statement.map((t) => t.value.toLowerCase());
		const analyze = statement.length === 3 && statement[0].kind === 'word' && values[0] === 'analyze' && ['identifier', 'word'].includes(statement[1].kind) && ['sqlite_schema', 'sqlite_master'].includes(values[1]);
		const insertStats = isStatistics(statement);
		if (!analyze && !insertStats) retained.push(sql.slice(start, tokens[i].end));
		start = tokens[i].end; first = i + 1;
	}
	retained.push(sql.slice(start));
	return retained.join('\n');
}
