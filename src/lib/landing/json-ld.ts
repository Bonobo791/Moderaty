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
// Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md

/**
 * Serialize data into a <script type="application/ld+json"> block safe for
 * {@html} injection. Escaping every "<" as the six characters \\u003c keeps the JSON valid
 * while making it impossible to close the script element (</script>) or
 * open an HTML comment (<!--) from inside a string value.
 */
export function jsonLd(data: object): string {
	const json = JSON.stringify(data).replaceAll('<', String.raw`\u003c`);
	return '<' + 'script type="application/ld+json">' + json + '</' + 'script>';
}
