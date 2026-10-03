/**
 * AI usage and cost per user, day (UTC), purpose and model (ext_ai_usage), for the daily
 * budget and reporting.
 */

import { getSupabaseClient } from "../../db/supabase.js";
import { costMicroUsd } from "./pricing.js";

export type Purpose = "jd_facts" | "fit" | "resume_profile" | "answer" | "onboarding";
export interface Usage { hit: number; miss: number; out: number; cost: number }

const db = () => getSupabaseClient();
export const today = () => new Date().toISOString().slice(0, 10);

export const dailyBudget = () => Number(process.env.EXT_AI_DAILY_BUDGET_MICRO_USD) || 100_000;

export async function spentToday(userId: string): Promise<number> {
  const { data, error } = await db().from("ext_ai_usage").select("cost_micro_usd").eq("user_id", userId).eq("day", today());
  if (error) throw error;
  return (data ?? []).reduce((n, r) => n + Number(r.cost_micro_usd), 0);
}

export async function recordUsage(userId: string, purpose: Purpose, model: string, u: { hit: number; miss: number; out: number }): Promise<Usage> {
  const cost = costMicroUsd(model, u);
  const { error } = await db().rpc("ext_add_ai_usage", {
    p_user_id: userId, p_day: today(), p_purpose: purpose, p_model: model,
    p_hit: u.hit, p_miss: u.miss, p_out: u.out, p_cost: cost,
  });
  if (error) console.error("[ext] AI usage not recorded", error.message);
  return { ...u, cost };
}
