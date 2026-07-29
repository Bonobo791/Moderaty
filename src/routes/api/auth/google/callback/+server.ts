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

import { redirect, error } from '@sveltejs/kit';

import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { channels } from '$lib/server/db/schema';
import { encrypt } from '$lib/server/crypto';

export async function GET({ url }) {
	const code = url.searchParams.get('code');
	if (!code) throw error(400, 'missing code');

	const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: env.GOOGLE_CLIENT_ID!,
			client_secret: env.GOOGLE_CLIENT_SECRET!,
			redirect_uri: `${env.APP_URL}/api/auth/google/callback`,
			grant_type: 'authorization_code'
		})
	});
	const tokens = await tokenRes.json();
	if (!tokenRes.ok || !tokens.refresh_token) {
		throw error(
			400,
			`token exchange failed: ${JSON.stringify(tokens)} — if this channel was connected before, revoke app access at myaccount.google.com/permissions and retry`
		);
	}

	const accessToken = tokens.access_token as string;
	const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
		headers: { Authorization: `Bearer ${accessToken}` }
	});
	const chData = await chRes.json();
	const ch = chData.items?.[0];
	if (!ch) throw error(400, 'no YouTube channel found for this Google account');

	await db
		.insert(channels)
		.values({
			id: ch.id,
			title: ch.snippet.title,
			refreshTokenEnc: encrypt(tokens.refresh_token),
			active: 1,
			createdAt: new Date().toISOString()
		})
		.onConflictDoUpdate({
			target: channels.id,
			set: { title: ch.snippet.title, refreshTokenEnc: encrypt(tokens.refresh_token), active: 1 }
		});

	throw redirect(302, '/');
}
