import type { ServiceWorkerScope } from "./service-worker";
import { installServiceWorker } from "./service-worker";

declare const self: ServiceWorkerScope;
// Replaced with the built shell and its versioned cache name by the PWA build plugin.
declare const __BOTCAMP_SW_PRECACHE__: string[];
declare const __BOTCAMP_SW_CACHE__: string;
declare const __BOTCAMP_SW_BASE__: string;

installServiceWorker(self, __BOTCAMP_SW_PRECACHE__, __BOTCAMP_SW_CACHE__, __BOTCAMP_SW_BASE__);
