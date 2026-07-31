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

/**
 * Serialize data into a <script type="application/ld+json"> block safe for
 * {@html} injection. Escaping every "<" as the six characters \\u003c keeps the JSON valid
 * while making it impossible to close the script element (</script>) or
 * open an HTML comment (<!--) from inside a string value.
 */
export function jsonLd(data: object): string {
	const json = JSON.stringify(data).replace(/</g, '\\u003c');
	return '<' + 'script type="application/ld+json">' + json + '</' + 'script>';
}
