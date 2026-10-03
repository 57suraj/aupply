/**
 * The debug log: a ring buffer of the last 300 lines in local storage, for "Copy debug log".
 * Timestamps, phases, lease ids, result codes and HTTP statuses only: never tokens, never answer
 * values, never resume or job description text.
 */

import { LIMITS } from "../shared/constants";
import { local } from "./store";

let chain: Promise<unknown> = Promise.resolve();

export function log(...parts: unknown[]) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`.slice(0, 400);
  console.log("[aupply]", line);
  chain = chain.then(async () => {
    const lines = (await local.get("log")) ?? [];
    lines.push(line);
    await local.set("log", lines.slice(-LIMITS.logLines));
  }).catch(() => undefined);
}

export async function logText() {
  return ((await local.get("log")) ?? []).join("\n");
}
