#!/usr/bin/env node
/**
 * One real call per AI tier (section 10.3), with the exact request shape src/extension/ai/client.ts
 * sends. Prints the model, latency, whether the content parsed as JSON, whether reasoning came back,
 * and the usage fields; checks that `thinking` reaches the wire and whether JSON mode works with
 * thinking on. Needs DEEPSEEK_API_KEY (from .env). Costs a fraction of a cent. Records nothing.
 *
 *   npm run ai:smoke
 */

import "dotenv/config";
import OpenAI from "openai";
import { buildParams, modelFor, tokensOf } from "../src/extension/ai/client.ts";
import { extractJson } from "../src/extension/ai/prompts/common.ts";
import { costMicroUsd } from "../src/extension/ai/pricing.ts";

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY is not set. Add it to .env (and to Vercel), then run npm run ai:smoke.");
  process.exit(2);
}

let lastBody = null;
const wireFetch = async (url, init) => {
  lastBody = init?.body ? JSON.parse(String(init.body)) : null;
  return fetch(url, init);
};
const client = new OpenAI({
  baseURL: process.env.AI_BASE_URL || "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY,
  timeout: 45_000,
  maxRetries: 0,
  fetch: wireFetch,
});

const SYSTEM = 'You answer in json only. Output one json object exactly in this shape: {"ok":true,"sum":0}';
const USER = "Add 2 and 3 and put the result in sum.";

async function once(label, params) {
  const t0 = Date.now();
  try {
    const res = await client.chat.completions.create(params);
    const ms = Date.now() - t0;
    const msg = res.choices[0]?.message ?? {};
    const parsed = extractJson(msg.content ?? "");
    const tokens = tokensOf(res.usage);
    console.log(`\n# ${label}`);
    console.log(`  model sent ${params.model}, answered by ${res.model}, ${ms} ms`);
    console.log(`  thinking on the wire: ${JSON.stringify(lastBody?.thinking)}  response_format: ${JSON.stringify(lastBody?.response_format ?? null)}`);
    console.log(`  content parsed as JSON: ${parsed ? JSON.stringify(parsed) : "NO (" + JSON.stringify((msg.content ?? "").slice(0, 120)) + ")"}`);
    console.log(`  reasoning_content present: ${Boolean(msg.reasoning_content)}${msg.reasoning_content ? ` (${msg.reasoning_content.length} chars)` : ""}`);
    console.log(`  usage: ${JSON.stringify(res.usage)}`);
    console.log(`  cost (peak prices): ${costMicroUsd(res.model || params.model, tokens)} micro-USD`);
    return { ok: Boolean(parsed), reasoning: Boolean(msg.reasoning_content) };
  } catch (err) {
    console.log(`\n# ${label}\n  FAILED: ${err?.status ?? ""} ${err?.message ?? err}`);
    return { ok: false, error: err };
  }
}

const fast = await once("fast tier (thinking disabled, JSON mode)", buildParams("fast", modelFor("fast"), SYSTEM, USER, 200));
const smart = await once("smart tier (thinking enabled, effort high, JSON mode)", buildParams("smart", modelFor("smart"), SYSTEM, USER, 200));
let smartNoJson = null;
if (!smart.ok) {
  const p = buildParams("smart", modelFor("smart"), SYSTEM, USER, 200);
  delete p.response_format;
  smartNoJson = await once("smart tier without response_format", p);
}

console.log("\n# Findings");
console.log(`  (a) thinking disabled accepted and no reasoning: ${fast.ok && !fast.reasoning ? "yes" : "NO"}`);
console.log(`  (b) JSON mode with thinking on: ${smart.ok ? "works" : smartNoJson?.ok ? "fails; without response_format it works (set AI_SMART_JSON_MODE=off)" : "fails both ways"}`);
process.exit(fast.ok && (smart.ok || smartNoJson?.ok) ? 0 : 1);
