/**
 * Vercel function for the Chrome extension channel. vercel.json rewrites /ext/* here;
 * req.url keeps the original path, so Express routes as usual. Independent of api/index.ts.
 */
export { default } from "../src/extension/server/app.js";
