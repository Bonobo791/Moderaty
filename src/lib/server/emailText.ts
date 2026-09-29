// Shared helpers for transactional e-mail bodies (contact verification,
// zero-credit retention notices). Server-only plain text/HTML construction —
// no dependencies.

/** Minimal HTML escaping for interpolated e-mail content (recipient names, URLs). */
export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => {
		switch (ch) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			default:
				return '&#39;';
		}
	});
}
