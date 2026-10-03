/**
 * The AI client (decision E7: DeepSeek through its OpenAI-compatible API, with the official
 * OpenAI SDK and a custom base URL). Two tiers:
 *   fast   AI_FAST_MODEL, thinking off, temperature 0, JSON mode: scoring and extraction
 *   smart  AI_SMART_MODEL, thinking on (effort high): hard form questions and onboarding
 * Every call checks the user's daily budget first, records its usage and cost after, and
 * returns schema-validated data or throws (AiBudgetExceeded, AiUnavailable): callers fall
 * back (scoring to the deterministic score, answering to "ask the user"). Outputs are data
 * only: validated, clamped and never executed (section 10.7).
 */

import OpenAI from "openai";
import type { z } from "zod";
import { fakeJson } from "./fake.js";
import { extractJson } from "./prompts/common.js";
import { dailyBudget, recordUsage, spentToday, type Purpose, type Usage } from "./usage.js";

export type Tier = "fast" | "smart";
export type { Purpose, Usage };

export class AiBudgetExceeded extends Error {
  constructor() {
    super("The daily AI budget for this user is spent.");
    this.name = "AiBudgetExceeded";
  }
}
export class AiUnavailable extends Error {
  constructor(why: string) {
    super(`AI unavailable: ${why}`);
    this.name = "AiUnavailable";
  }
}

export const modelFor = (tier: Tier) => (tier === "fast" ? process.env.AI_FAST_MODEL : process.env.AI_SMART_MODEL) || "deepseek-flash";
export const aiFake = () => process.env.AI_FAKE === "1";

/** Smart tier and JSON mode: whether response_format json_object is sent with thinking on
    (scripts/ai-smoke.mjs checks it; docs/extension/DESIGN.md records the finding). Without it
    the prompt still asks for json and extractJson finds the object in the content. */
const SMART_JSON_MODE = process.env.AI_SMART_JSON_MODE !== "off";
/** Thinking tokens are output tokens: room for them on top of the answer. */
const SMART_REASONING_ROOM = 6000;

/** The request body for a tier. `thinking` is not in the OpenAI SDK's types, so it is added
    with a narrow cast; ai-smoke confirms it reaches the wire. */
export function buildParams(tier: Tier, model: string, system: string, user: string, maxTokens: number) {
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  if (tier === "fast") {
    return {
      model, messages, temperature: 0, max_tokens: maxTokens,
      response_format: { type: "json_object" as const },
      thinking: { type: "disabled" },
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & { thinking: { type: string } };
  }
  return {
    model, messages, max_tokens: maxTokens + SMART_REASONING_ROOM,
    reasoning_effort: "high" as const,
    ...(SMART_JSON_MODE ? { response_format: { type: "json_object" as const } } : {}),
    thinking: { type: "enabled" },
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & { thinking: { type: string } };
}

let client: OpenAI | null = null;
function api(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new AiUnavailable("DEEPSEEK_API_KEY is not set");
  return (client ??= new OpenAI({ baseURL: process.env.AI_BASE_URL || "https://api.deepseek.com", apiKey, timeout: 45_000, maxRetries: 0 }));
}

type ApiUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number } | null | undefined;
export function tokensOf(u: ApiUsage) {
  const hit = u?.prompt_cache_hit_tokens ?? 0;
  const miss = u?.prompt_cache_miss_tokens ?? Math.max(0, (u?.prompt_tokens ?? 0) - hit);
  return { hit, miss, out: u?.completion_tokens ?? 0 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT_WAITS = [2000, 6000];

export async function callJson<T>(o: {
  userId: string;
  tier: Tier;
  purpose: Purpose;
  /** Which fake answers in AI_FAKE mode, when it is not the purpose itself (a purpose has several prompts). */
  fake?: "answer_match";
  system: string;
  /** Stable content first (the prefix cache). */
  user: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  maxTokens: number;
}): Promise<{ data: T; model: string; usage: Usage }> {
  if ((await spentToday(o.userId)) >= dailyBudget()) throw new AiBudgetExceeded();

  if (aiFake()) {
    const parsed = o.schema.safeParse(fakeJson(o.fake ?? o.purpose, o.user));
    if (!parsed.success) throw new AiUnavailable("fake output failed its schema");
    const usage = await recordUsage(o.userId, o.purpose, "fake", { hit: 0, miss: Math.ceil((o.system.length + o.user.length) / 4), out: 50 });
    return { data: parsed.data, model: "fake", usage };
  }

  const model = modelFor(o.tier);
  const params = buildParams(o.tier, model, o.system, o.user, o.maxTokens);
  let badOutputs = 0;
  let transient = 0;
  for (;;) {
    let res: OpenAI.Chat.ChatCompletion;
    try {
      res = await api().chat.completions.create(params);
    } catch (err) {
      if (err instanceof AiUnavailable) throw err;
      const status = (err as { status?: number }).status;
      // 429, 5xx, timeouts and dropped connections: up to two retries, 2s then 6s.
      if ((status === undefined || status === 429 || status >= 500) && transient < TRANSIENT_WAITS.length) {
        await sleep(TRANSIENT_WAITS[transient++]);
        continue;
      }
      throw new AiUnavailable(status ? `HTTP ${status}` : (err as Error).name || "network error");
    }
    const tokens = tokensOf(res.usage as ApiUsage);
    const usage = await recordUsage(o.userId, o.purpose, res.model || model, tokens);
    const content = res.choices[0]?.message?.content ?? "";
    const parsed = o.schema.safeParse(extractJson(content));
    if (parsed.success) return { data: parsed.data, model: res.model || model, usage };
    // Empty content (DeepSeek warns JSON mode can return it), invalid JSON or a schema failure: one retry.
    if (badOutputs++ < 1) continue;
    throw new AiUnavailable(content.trim() ? "output failed its schema" : "empty content");
  }
}
