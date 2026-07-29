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

import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { env } from '$env/dynamic/private';
import * as schema from '$lib/server/db/schema';

const databaseUrl = env.TURSO_DATABASE_URL;
const authToken = env.TURSO_AUTH_TOKEN;

if (!databaseUrl) {
	throw new Error('TURSO_DATABASE_URL is required');
}
const isLocalUrl = databaseUrl === ':memory:' || databaseUrl.startsWith('file:');
if (!isLocalUrl && !authToken) {
	throw new Error('TURSO_AUTH_TOKEN is required for remote databases');
}

const client = createClient({
	url: databaseUrl,
	authToken: authToken || undefined
});

export const db = drizzle(client, { schema });
