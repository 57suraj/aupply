/**
 * The engines' answer resolver, evaluated on the server so resolve_answers answers a
 * question exactly as a browser engine would: the same built module parts (core and
 * res_*), instantiated the same way the boot part does it in the page.
 */

import vm from "node:vm";
import { MODULES, RESOLVER_MODULES } from "../engines/generated.js";

export interface ResolverAnswer {
  k: string;
  v: string | null;
  text?: string;
  yn?: "yes" | "no" | null;
  protected?: boolean;
  what?: string;
  eeo?: boolean;
  money?: number | null;
  days?: number | null;
}

export interface Resolver {
  A(question: string, company?: string): ResolverAnswer | null;
  pickOpt(a: ResolverAnswer | null, texts: string[]): number;
  lowStakes(question: string, texts: string[]): number;
  norm(s: string): string;
}

type Factory = (X: Record<string, unknown>) => Record<string, unknown>;
let factories: Factory[] | null = null;

function load(): Factory[] {
  const ctx: Record<string, unknown> = {};
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const n of RESOLVER_MODULES) vm.runInContext(MODULES[n].code, ctx, { filename: n });
  const m = (ctx.__ap as { m: Record<string, Factory> }).m;
  return RESOLVER_MODULES.map((n) => m[n]);
}

export function makeResolver(cfg: object, source: string): Resolver {
  factories ??= load();
  const X: Record<string, unknown> = { CFG: cfg, SOURCE: source };
  for (const f of factories) Object.assign(X, f(X));
  return X.R as Resolver;
}

/** How a platform names itself in "how did you hear about us" options. */
export const SOURCE_NAMES: Record<string, string> = {
  linkedin: "LinkedIn",
  naukri: "Naukri",
  wellfound: "Wellfound",
  indeed: "Indeed",
};
