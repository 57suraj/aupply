import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.js";

export type TypedSupabaseClient = SupabaseClient<Database>;

let _supabase: TypedSupabaseClient | null = null;

/**
 * Returns the Supabase admin client (lazily initialized).
 *
 * Uses the service-role key which bypasses Row Level Security.
 * This client must ONLY be used server-side, AFTER the authenticated user's
 * identity has been verified via OAuth. Never expose it to client-facing code.
 *
 * Throws if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY are not set — surfacing
 * the error at call time rather than at module import time.
 */
export function getSupabaseClient(): TypedSupabaseClient {
  if (_supabase) return _supabase;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      "Missing required environment variables: " +
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."
    );
  }

  _supabase = createClient<Database>(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      // Disable automatic session management — auth is handled externally via OAuth.
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return _supabase;
}

/**
 * Convenience re-export for direct usage.
 * Prefer `getSupabaseClient()` in tool handlers to get clear errors when
 * env vars are missing.
 */
export const supabase = new Proxy({} as TypedSupabaseClient, {
  get(_target, prop) {
    return (getSupabaseClient() as unknown as Record<string, unknown>)[prop as string];
  },
});
