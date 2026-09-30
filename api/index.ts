/**
 * Vercel function entrypoint. vercel.json rewrites every backend path
 * (/mcp, /api/*, /oauth/authorize|token|callback, /health, /.well-known/*)
 * to this function; req.url keeps the original path, so Express routes as usual.
 */
import app from "../src/app.js";

export default app;
