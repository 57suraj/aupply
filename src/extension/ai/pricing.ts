/**
 * DeepSeek prices per 1M tokens, peak rates as the conservative default (off-peak is half).
 * AI_PRICES_JSON overrides the table: {"model": {"hit": 0.006, "miss": 0.30, "out": 1.20}}.
 * Checked 4 Oct 2026 against api-docs.deepseek.com/quick_start/pricing: the same numbers.
 * deepseek-v4-pro keeps its list price here even while it may bill at Flash rates (the plan's
 * routing note), so a re-routed model is never undercounted.
 */

export interface Price { hit: number; miss: number; out: number }

const DEFAULT_PRICES: Record<string, Price> = {
  "deepseek-flash": { hit: 0.006, miss: 0.3, out: 1.2 },
  "deepseek-v4-pro": { hit: 0.044, miss: 1.32, out: 3.96 },
};

let table: Record<string, Price> | null = null;

function prices(): Record<string, Price> {
  if (table) return table;
  table = { ...DEFAULT_PRICES };
  try {
    const extra = JSON.parse(process.env.AI_PRICES_JSON || "{}") as Record<string, Price>;
    for (const [model, p] of Object.entries(extra)) {
      if ([p?.hit, p?.miss, p?.out].every((n) => typeof n === "number" && n >= 0)) table[model] = p;
    }
  } catch {
    console.error("[ext] AI_PRICES_JSON is not valid JSON; using the default prices");
  }
  return table;
}

/** An unknown model is priced as the most expensive entry. */
export function priceOf(model: string): Price {
  const t = prices();
  if (t[model]) return t[model];
  return Object.values(t).reduce((a, b) => (a.miss + a.out >= b.miss + b.out ? a : b));
}

/** Cost in whole micro-dollars (USD), rounded up. Price is $ per 1M tokens, so tokens x price is micro-dollars. */
export function costMicroUsd(model: string, u: { hit: number; miss: number; out: number }): number {
  if (model === "fake") return 0;
  const p = priceOf(model);
  return Math.ceil(u.hit * p.hit + u.miss * p.miss + u.out * p.out);
}
