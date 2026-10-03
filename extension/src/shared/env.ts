/**
 * Where Aupply is and which version this is, set at build time. Imported by the service worker and
 * the side panel only: the content script never contacts Aupply, so it does not even hold its address.
 */

export const BASE_URL: string = typeof __AUPPLY_BASE_URL__ === "string" ? __AUPPLY_BASE_URL__ : "https://aupply.vercel.app";
export const EXT_VERSION: string = typeof __EXT_VERSION__ === "string" ? __EXT_VERSION__ : "0.0.0";
export const API = `${BASE_URL}/ext/v1`;
