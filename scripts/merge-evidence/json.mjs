import { readFileSync } from 'node:fs';

export function readJson(path, label) {
	return parseJson(readFileSync(path, 'utf8'), label);
}

export function parseJson(text, label) {
	try { return JSON.parse(text); }
	catch { throw new Error(`Merge evidence rejected: invalid JSON in ${label}`); }
}
