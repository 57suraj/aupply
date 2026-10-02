/**
 * Engine delivery. The engine is Aupply's product, so the server decides what Claude gets
 * and when; nothing is ever sent whole.
 *
 * - A platform tool issues an engine: the user's config is stored (platform_state, one row
 *   per user and engine, overwritten by the next issue) and Claude gets an id plus a tiny
 *   loaded_check, never code.
 * - Claude runs loaded_check in its page and, unless that answers ok, asks load_engine with
 *   the page's answer. load_engine plans from that state (src/engines/index.ts) and sends
 *   only the next few parts the page lacks, a bounded number of bytes at a time.
 * - Deliveries are metered per user, engine and day: a few full loads are a normal day
 *   (a page that reloads needs one), more is a loop or a scrape, and it is refused.
 * - Backoffs apply here too: no part is sent for a platform that is in a rate-limit backoff.
 */

import { AppError } from "../lib/errors.js";
import {
  answersNeeded, buildEngine, engineVersion, fullSize, isEngineName, parsePage, planLoad,
  type EngineName, type Part,
} from "../engines/index.js";
import { activeBlock, getState, mergeState } from "./automation.js";

type Meta = Record<string, any>;

/** Bytes of engine code per load_engine answer, and of everything in it (the user's config
    and the boot part only count against the larger total). Two full-size parts (PART_MAX 9KB)
    at most, and planLoad never puts every module of an engine in one answer. 12KB sent one
    part per answer (2 Oct: the apply engine took 7 answers, each a load_engine round trip). */
export const BATCH_MODULE_BYTES = 17_000;
export const BATCH_TOTAL_BYTES = 32_000;
/** Full engines per user, engine and day. Reloading a page, or a retry, costs a part of one. */
export const DAY_LOADS = 6;
/** A stored config older than this is stale: the platform tool must issue it again. */
const ISSUE_TTL_MS = 8 * 3600_000;

const scope = (name: EngineName) => `engine_${name}`;
const BACKOFFS: Record<EngineName, string[]> = {
  linkedin_draft: ["linkedin", "linkedin_guest"],
  linkedin: ["linkedin"],
  naukri: ["naukri"],
  wellfound: ["wellfound"],
  indeed: ["indeed"],
};

export interface Delivery {
  data: Record<string, unknown>;
  /** Code, each block a verbatim text block in the tool result. */
  blocks: string[];
}

/** A block of code Claude runs: a comment naming it, then the code, nothing to unescape. */
export const codeBlock = (label: string, code: string) => `/*aupply ${label}*/\n${code}`;
const partBlock = (b: { name: string; version: string }, p: Part) => codeBlock(`${b.name}@${b.version} ${p.name}`, p.code);

/** Store the user's config for this engine and return the id Claude passes to load_engine. */
export async function issueEngine(userId: string, name: EngineName, cfg: { h: string }) {
  await mergeState(userId, scope(name), { cfg, h: cfg.h, at: new Date().toISOString() });
  return { id: `${name}@${engineVersion(name)}.${cfg.h}`, loadedCheck: buildEngine(name, cfg).loadedCheck };
}

const FAILURE =
  "A block that fails (SyntaxError, 'Invalid or unexpected token' or an answer starting 'corrupt') was mistyped: copy that " +
  "block again exactly and rerun it. After 3 failures of the same block, stop and tell the user the exact error.";

export async function loadEngine(userId: string, engineId: string, page: string | undefined): Promise<Delivery> {
  const m = /^([a-z_]+)@([0-9a-f]+)\.([0-9a-f]+)$/.exec(engineId.trim());
  if (!m || !isEngineName(m[1])) throw new AppError("Unknown engine id: pass the `engine` from the platform tool's response, exactly as given.");
  const name = m[1];
  const done = (data: Record<string, unknown>): Delivery => ({ data: { engine: engineId, ...data }, blocks: [] });

  const block = await activeBlock(userId, BACKOFFS[name]);
  if (block) {
    return done({ blocked: true, scope: block.scope, until: block.until, next: `Rate-limit backoff: do not use ${block.scope} until ${block.until}. Work another platform meanwhile.` });
  }

  const row = await getState(userId, scope(name));
  const st = (row?.state ?? {}) as Meta;
  const stale = !st.cfg || st.h !== m[3] || m[2] !== engineVersion(name) || !(Date.now() - Date.parse(st.at) < ISSUE_TTL_MS);
  if (stale) return done({ stale: true, next: "This engine id is out of date. Call the platform tool again and use the new `engine` it returns." });

  const b = buildEngine(name, st.cfg);
  const limits = { modules: BATCH_MODULE_BYTES, total: BATCH_TOTAL_BYTES };
  const state = parsePage(page);
  const plan = planLoad(b, state, limits);
  if (plan.ready) return done({ ready: true, next: "The engine is loaded in this page. Continue with the steps." });

  const day = new Date().toISOString().slice(0, 10);
  const served = st.served?.day === day ? Number(st.served.bytes) || 0 : 0;
  if (served + plan.bytes > fullSize(b) * DAY_LOADS) {
    console.warn("[engine] limit", JSON.stringify({ u: userId.slice(0, 8), engine: name, served }));
    return done({ limit: true, next: "Today's engine delivery limit for this platform is used. Do not retry: stop using it until tomorrow and tell the user." });
  }
  await mergeState(userId, scope(name), { served: { day, bytes: served + plan.bytes } } as Meta, row);
  console.log("[engine] served", JSON.stringify({ u: userId.slice(0, 8), engine: name, parts: plan.batch.map((p) => p.name), bytes: plan.bytes, left: plan.left }));

  return {
    data: {
      engine: engineId,
      blocks: plan.batch.map((p) => p.name),
      ...(plan.left ? { more: plan.left, answers_left: answersNeeded(b, state, limits) - 1 } : {}),
      next: plan.left
        ? "Run each block below as its own JavaScript call, in this order, exactly as written. Then call load_engine again with engine and page = the answer of the last block. " + FAILURE
        : "Run each block below as its own JavaScript call, in this order, exactly as written. The last block (boot) answers {ok:true,...} when the engine is ready. If it answers RUNNING, a script is live in this page: wait for it to finish first. If it answers anything else, run loaded_check and call load_engine once more with its answer; if that fails too, stop and tell the user the exact answer. " + FAILURE,
    },
    blocks: plan.batch.map((p) => partBlock(b, p)),
  };
}
