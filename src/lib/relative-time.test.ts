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

import { describe, expect, it } from 'vitest';
import { relativeTime } from './relative-time';

const NOW = new Date('2026-07-30T12:00:00Z');

describe('relativeTime', () => {
	it('renders each bucket with correct pluralization', () => {
		expect(relativeTime('2026-07-30T11:59:40Z', NOW)).toBe('just now');
		expect(relativeTime('2026-07-30T11:59:00Z', NOW)).toBe('1 minute ago');
		expect(relativeTime('2026-07-30T10:00:00Z', NOW)).toBe('2 hours ago');
		expect(relativeTime('2026-07-29T12:00:00Z', NOW)).toBe('1 day ago');
		expect(relativeTime('2026-07-16T12:00:00Z', NOW)).toBe('2 weeks ago');
	});

	it('returns unparseable input unchanged instead of crashing', () => {
		expect(relativeTime('not-a-date', NOW)).toBe('not-a-date');
	});
});
