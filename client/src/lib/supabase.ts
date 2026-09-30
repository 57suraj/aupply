import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "[supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
    "Set these in your .env file."
  );
}

/**
 * Browser-side Supabase client.
 * Uses the anon key: safe to expose to the browser.
 * Row Level Security policies ensure users can only access their own data.
 */
export const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnonKey || "placeholder",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  }
);
