import type { LayoutServerLoad } from './$types';
import { siteOrigin } from '$lib/server/siteIndex';

export const load: LayoutServerLoad = () => ({ siteOrigin: siteOrigin() });
