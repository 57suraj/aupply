/**
 * The engines' answer resolver, evaluated on the server so resolve_answers answers a
 * question exactly as a browser engine would. The source is shared/core.js +
 * shared/resolver.js, emitted by scripts/build-engines.mjs.
 */

import vm from "node:vm";
import { RESOLVER_SOURCE } from "../engines/generated.js";

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
  A(question: string): ResolverAnswer | null;
  pickOpt(a: ResolverAnswer | null, texts: string[]): number;
  lowStakes(question: string, texts: string[]): number;
  norm(s: string): string;
}

let factory: ((cfg: object, source: string) => Resolver) | null = null;

export function makeResolver(cfg: object, source: string): Resolver {
  factory ??= vm.runInNewContext(`${RESOLVER_SOURCE}\n;makeResolver`, {}, { filename: "resolver.js" }) as (cfg: object, source: string) => Resolver;
  return factory(cfg, source);
}

/** How a platform names itself in "how did you hear about us" options. */
export const SOURCE_NAMES: Record<string, string> = {
  linkedin: "LinkedIn",
  naukri: "Naukri",
  wellfound: "Wellfound",
  indeed: "Indeed",
};
