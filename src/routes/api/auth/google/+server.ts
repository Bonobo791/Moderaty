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

import { redirect } from '@sveltejs/kit';

import { env } from '$env/dynamic/private';

export function GET() {
	const params = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID!,
		redirect_uri: `${env.APP_URL}/api/auth/google/callback`,
		response_type: 'code',
		scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
		access_type: 'offline',
		prompt: 'consent'
	});
	throw redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
