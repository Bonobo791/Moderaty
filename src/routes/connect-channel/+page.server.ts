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
// Commercial licensing: contact@AdvancedDigitalMarketingLTDA.com — see COMMERCIAL.md

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
	// The pick is bound to the signed-in user who parked it: on a shared
	// machine, a different user reading it sees "expired" and reconnects.
	const pending = readPendingChannelPick(cookies, state, user.id);
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
		const pending = state ? readPendingChannelPick(cookies, state, user.id) : null;
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
