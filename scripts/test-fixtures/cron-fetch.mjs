// Test-only preload: fixtures are JSON data, never executable source. Loading
// this before the driver replaces every app/monitor request with a local reply.
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.MODERATY_CRON_FIXTURE_PATH, 'utf8'));
if (!Number.isInteger(fixture.status) || fixture.status < 200 || fixture.status > 599) {
	throw new Error('Invalid cron fixture status');
}
let requests = 0;
globalThis.fetch = async () => {
	requests++;
	return new Response(JSON.stringify(fixture.payload), { status: fixture.status });
};
process.on('exit', () => console.error('fixture-requests=' + requests));
