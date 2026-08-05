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

import { error, fail, redirect } from '@sveltejs/kit';

import {
	clearPendingChannelPick,
	readPendingChannelPick,
	upsertChannelConnection
} from '$lib/server/channelConnect';
import { requireOrgRole } from '$lib/server/ownership';
import { requireUser } from '$lib/server/session';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies, url, locals }) => {
	// Same gate as the OAuth callback that parks the pick: signed-in admin+ of
	// the active team. Members moderate; they don't connect channels.
	const user = requireUser(locals);
	requireOrgRole(user, 'admin');

	const state = url.searchParams.get('state');
	if (!state) throw error(400, 'missing state — restart the channel connection from the dashboard');
	const pending = readPendingChannelPick(cookies, state);
	if (!pending) {
		throw error(400, 'this channel selection expired — reconnect the channel from the dashboard');
	}
	// Only the candidate list reaches the browser — the parked refresh token
	// never leaves the encrypted cookie until a channel is chosen.
	return { channels: pending.channels };
};

export const actions: Actions = {
	default: async ({ cookies, request, url, locals }) => {
		const user = requireUser(locals);
		requireOrgRole(user, 'admin');

		const state = url.searchParams.get('state');
		const pending = state ? readPendingChannelPick(cookies, state) : null;
		if (!pending) {
			return fail(400, { error: 'This channel selection expired — reconnect the channel from the dashboard.' });
		}

		const form = await request.formData();
		const chosen = form.get('channel');
		// The choice must be one of the channels Google's callback parked —
		// anything else is tampering and fails loudly.
		// Stryker disable next-line ConditionalExpression: equivalent when the condition is forced true — readPendingChannelPick validated every pending.channels id as a string, so for a non-string `chosen` (null/File) `c.id === chosen` is always false and find yields the same undefined as the `: undefined` branch; note this directive also sweeps the same-line ConditionalExpression→false sibling, which the 'choosing a parked channel connects it' test kills when not ignored
		const channel = typeof chosen === 'string' ? pending.channels.find((c) => c.id === chosen) : undefined;
		if (!channel) {
			return fail(400, { error: 'Unknown channel — pick one of the listed channels.' });
		}

		if ((await upsertChannelConnection(user, channel, pending.refreshToken)) === 'conflict') {
			return fail(409, { error: 'This channel is connected to a different Moderaty team.' });
		}

		// Consumed on success only: a transient failure leaves the pick
		// retryable while a success cannot be replayed.
		clearPendingChannelPick(cookies, state as string);
		throw redirect(302, '/dashboard');
	}
};
