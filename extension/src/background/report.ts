/**
 * Events the extension sends to Aupply (POST /events -> ext_events), so a live run's trouble can
 * be read on the server without the user pasting a log: stops, pauses, stalls, refusals, handoffs
 * and the end of a run. Codes, counts and statuses only: never tokens, answers, resume or job text.
 * Fire and forget: a failed report never affects the run.
 */

import { OkResponse } from "../../../src/extension/contract";
import { call } from "./api";
import { log } from "./log";

export function report(level: "info" | "warn" | "error", type: string, runId: string | undefined, data: Record<string, unknown> = {}) {
  log("event", level, type, data);
  void call("POST", "/events", { events: [{ level, type, ...(runId ? { run_id: runId } : {}), data, at: new Date().toISOString() }] }, OkResponse).catch(() => undefined);
}
