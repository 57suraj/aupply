/**
 * Single definitions that live inside the built engine modules, loaded on the server through
 * node:vm the way src/platforms/resolver.ts loads the resolver (the loading pattern only, no
 * logic copied): a context whose window is itself, each module's built code run in dependency
 * order, the factories read from __ap.m. The extension channel parses, prescreens and answers
 * with exactly the code the MCP engines run, so the two channels never drift.
 *
 *   clean(html)   core: HTML to text, as the prescreen reads a posting
 *   yearsOf(text) li_screen: years from the first match that reads as a requirement
 *   NEVERTICK     res_base: marketing, SMS and "follow company", never ticked
 *   CONSENT       li_dom: consent that comes with an application, accepted
 */

import vm from "node:vm";
import { MODULES, RESOLVER_MODULES } from "../../engines/generated.js";
import { answerPack, type UserData } from "../../platforms/config.js";
import { makeResolver, type Resolver } from "../../platforms/resolver.js";

type Factory = (X: Record<string, unknown>) => Record<string, unknown>;
type ModuleName = keyof typeof MODULES;

let factories: Record<string, Factory> | null = null;

function load(): Record<string, Factory> {
  const ctx: Record<string, unknown> = {};
  ctx.window = ctx;
  vm.createContext(ctx);
  const names: ModuleName[] = [...RESOLVER_MODULES, "li_screen", "li_dom"];
  for (const n of names) vm.runInContext(MODULES[n].code, ctx, { filename: n });
  return (ctx.__ap as { m: Record<string, Factory> }).m;
}

const F = () => (factories ??= load());

export interface EngineDefs {
  clean: (html: string) => string;
  yearsOf: (text: string) => { minY: number | null; yu?: number };
  NEVERTICK: RegExp;
  CONSENT: RegExp;
}

let defs: EngineDefs | null = null;

export function engineDefs(): EngineDefs {
  if (defs) return defs;
  const f = F();
  const { clean } = f.core({}) as { clean: EngineDefs["clean"] };
  const { yearsOf } = f.li_screen({ CFG: {} }) as { yearsOf: EngineDefs["yearsOf"] };
  // The resolver context, built the way makeResolver builds it, for res_base's NEVERTICK.
  const X: Record<string, unknown> = { CFG: {}, SOURCE: "LinkedIn" };
  for (const n of RESOLVER_MODULES) Object.assign(X, f[n](X));
  const NEVERTICK = X.NEVERTICK as RegExp;
  const { CONSENT } = f.li_dom({ txt: () => "", cut: (s: string) => s, NEVERTICK }) as { CONSENT: RegExp };
  defs = { clean, yearsOf, NEVERTICK, CONSENT };
  return defs;
}

/** The resolver's R has the money parsers too (pay module); resolver.ts types only what the MCP uses. */
export type FullResolver = Resolver & {
  payMax(text: string): number | null;
  moneyRange(text: string): [number, number] | null;
};

/** One resolver for this user, as resolve_answers builds it (every saved answer, LinkedIn as the source). */
export function resolverFor(d: UserData): FullResolver {
  return makeResolver(answerPack(d, undefined, 1000), "LinkedIn") as FullResolver;
}

/** A resolver with no user data: enough for payMax in the prescreen. */
let bare: FullResolver | null = null;
export function payMax(text: string): number | null {
  bare ??= makeResolver({}, "LinkedIn") as FullResolver;
  return bare.payMax(text);
}

/** Startup self-check (logged once, covered in e2e): the loaded definitions behave. */
export function selfCheck(): string[] {
  const fails: string[] = [];
  try {
    const d = engineDefs();
    if (d.yearsOf("3+ years of experience required").minY !== 3) fails.push("yearsOf");
    if (payMax("Rs 10 - 20 LPA") !== 2000000) fails.push("payMax");
    if (!d.NEVERTICK.test("Follow Acme")) fails.push("NEVERTICK");
    if (!d.CONSENT.test("I agree to the privacy policy")) fails.push("CONSENT");
    if (d.clean("<p>Hello&nbsp;<b>world</b></p>") !== "Hello world") fails.push("clean");
  } catch (err) {
    fails.push(`load: ${err instanceof Error ? err.message : String(err)}`);
  }
  return fails;
}
