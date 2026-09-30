/**
 * Connections: the OAuth grants a user has given (e.g. Claude), shown in the
 * dashboard and revocable there. Revoking cuts off access tokens immediately.
 */

import { getSupabaseClient } from "../db/supabase.js";
import { notFound, unwrap } from "../lib/errors.js";
import { revokeGrant } from "../auth/oauthProvider.js";

export async function listConnections(userId: string) {
  const rows = unwrap(
    await getSupabaseClient()
      .from("oauth_grants")
      .select("id, scopes, created_at, last_used_at, client:oauth_clients(client_name, redirect_uris)")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
  );
  return rows.map(({ client, ...grant }) => ({
    ...grant,
    client_name: client?.client_name ?? "Unnamed application",
    redirect_host: client?.redirect_uris?.[0] ? new URL(client.redirect_uris[0]).host : null,
  }));
}

export async function revokeConnection(userId: string, grantId: string) {
  if (!(await revokeGrant(grantId, userId))) throw notFound("Connection");
}
