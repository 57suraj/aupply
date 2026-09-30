/**
 * Shared plumbing for MCP tools.
 *
 * The user id comes only from the verified OAuth token (authInfo.extra.userId,
 * set by oauthProvider.verifyAccessToken). Tools never accept a user id as input.
 */

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { AppError, messageOf } from "../lib/errors.js";

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
export const IDEMPOTENT_WRITE: ToolAnnotations = { ...WRITE, idempotentHint: true };

function userIdOf(extra: { authInfo?: AuthInfo }): string {
  const userId = extra.authInfo?.extra?.userId;
  if (typeof userId !== "string" || !userId) {
    throw new AppError("Not authenticated. Reconnect Aupply in Claude's settings.", 401);
  }
  return userId;
}

/** Drop nulls, empty strings/arrays/objects so tool output costs fewer tokens. */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compact(v);
      const empty =
        c === null ||
        c === undefined ||
        c === "" ||
        (Array.isArray(c) && c.length === 0) ||
        (typeof c === "object" && !Array.isArray(c) && Object.keys(c as object).length === 0);
      if (!empty) out[k] = c;
    }
    return out;
  }
  return value;
}

/** Run a tool body for the authenticated user and shape the result or error. */
export async function run(
  extra: { authInfo?: AuthInfo },
  body: (userId: string) => Promise<unknown>
): Promise<CallToolResult> {
  try {
    const result = await body(userIdOf(extra));
    return { content: [{ type: "text", text: JSON.stringify(compact(result ?? { ok: true })) }] };
  } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500) console.error("[mcp] tool failed:", err);
    return { isError: true, content: [{ type: "text", text: messageOf(err) }] };
  }
}
