import type { LayoutServerLoad } from './$types';
import { siteOrigin } from '$lib/server/siteIndex';

/** Supply only the configured public origin to blog page metadata. */
export const load: LayoutServerLoad = () => ({ siteOrigin: siteOrigin() });
