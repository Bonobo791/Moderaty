/**
 * Serialize data into a <script type="application/ld+json"> block safe for
 * {@html} injection. Escaping every "<" as the six characters \\u003c keeps the JSON valid
 * while making it impossible to close the script element (</script>) or
 * open an HTML comment (<!--) from inside a string value.
 */
export function jsonLd(data: object): string {
	const json = JSON.stringify(data).replace(/</g, String.raw`\u003c`);
	return '<' + 'script type="application/ld+json">' + json + '</' + 'script>';
}
