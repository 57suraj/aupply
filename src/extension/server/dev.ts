/**
 * Local server for the extension channel (the Vite dev server proxies /ext here).
 * On Vercel this file is not used: api/ext.ts exports the app.
 */

import app from "./app.js";

const PORT = Number(process.env.EXT_PORT) || 3001;

app.listen(PORT, () => {
  console.log(`Aupply extension API on http://localhost:${PORT}/ext/v1 (health: /ext/v1/health)`);
});
