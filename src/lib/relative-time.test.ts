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
		expect(relativeTime('2026-06-30T12:00:00Z', NOW)).toBe('1 month ago');
		expect(relativeTime('2026-05-31T12:00:00Z', NOW)).toBe('2 months ago');
		expect(relativeTime('2025-07-30T12:00:00Z', NOW)).toBe('1 year ago');
		expect(relativeTime('2021-07-30T12:00:00Z', NOW)).toBe('5 years ago');
	});

	it('places exact bucket boundaries in the next bucket up', () => {
		// diff === HOUR must render hours, not "60 minutes"
		expect(relativeTime('2026-07-30T11:00:00Z', NOW)).toBe('1 hour ago');
		// diff === WEEK must render weeks, not "7 days"
		expect(relativeTime('2026-07-23T12:00:00Z', NOW)).toBe('1 week ago');
	});

	it('returns unparseable input unchanged instead of crashing', () => {
		expect(relativeTime('not-a-date', NOW)).toBe('not-a-date');
	});
});
