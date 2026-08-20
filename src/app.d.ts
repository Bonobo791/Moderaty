// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type { SessionUser } from '$lib/server/session';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: SessionUser | null;
			/** Set by hooks when the database is unreachable: pages render a maintenance state instead of a 500. */
			dbDown?: boolean;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}
