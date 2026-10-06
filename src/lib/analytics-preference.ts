export const ANALYTICS_OPT_OUT_KEY = 'moderaty.analytics.optOut';
export const ANALYTICS_PREFERENCE_EVENT = 'moderaty:analytics-preference';
const unavailableDocuments = new WeakSet<Window>();
const message = 'Audience measurement preference is unavailable.';

/** A storage error permanently blocks measurement in this document. */
function unavailable(): never {
	unavailableDocuments.add(window);
	window.dispatchEvent(new Event(ANALYTICS_PREFERENCE_EVENT));
	throw new Error(message);
}

/** Reads only the local opt-out flag; never stores measurement identifiers. */
export function getAnalyticsOptOut(): boolean {
	if (unavailableDocuments.has(window)) throw new Error(message);
	try { return window.localStorage.getItem(ANALYTICS_OPT_OUT_KEY) === '1'; }
	catch { return unavailable(); }
}

/** Writes/removes one flag and notifies this document's client immediately. */
export function setAnalyticsOptOut(disabled: boolean): void {
	try {
		if (disabled) window.localStorage.setItem(ANALYTICS_OPT_OUT_KEY, '1');
		else window.localStorage.removeItem(ANALYTICS_OPT_OUT_KEY);
	} catch { unavailable(); }
	window.dispatchEvent(new Event(ANALYTICS_PREFERENCE_EVENT));
}

/** Browser privacy signals take precedence over a site's local preference. */
export function browserRequestsPrivacy(): boolean {
	const privacyNavigator = navigator as Navigator & { globalPrivacyControl?: boolean };
	const privacyWindow = window as Window & { doNotTrack?: string };
	return privacyNavigator.globalPrivacyControl === true ||
		[navigator.doNotTrack, privacyWindow.doNotTrack].some((signal) => ['1', 'yes'].includes(signal ?? ''));
}
