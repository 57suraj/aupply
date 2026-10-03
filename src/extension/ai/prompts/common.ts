/**
 * Helpers every prompt shares: data minimisation (contact details out of resume text), stable
 * serialisation (DeepSeek's prefix cache hits only on byte-identical prefixes), and bounded
 * strings and lists for validated outputs.
 */

import { z } from "zod";

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// A run of digits and separators; only one holding 10 to 13 digits is a phone ("2019 - 2023" is not).
const PHONE_LIKE = /\+?\d[\d\s().-]{8,20}\d/g;
const ADDRESS_WORDS = /\b(street|st\.|road|rd\.|lane|avenue|ave\.|nagar|colony|sector|block|apartment|apt\.?|flat|floor|house no|h\.?\s?no|layout|marg|cross|main road|near|opp\.?|pin ?code|zip)\b/i;

export const extractEmail = (text: string) => (text.match(EMAIL) ?? [])[0] ?? null;
export function extractPhone(text: string): string | null {
  for (const m of text.match(PHONE_LIKE) ?? []) {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 13) return m.trim();
  }
  return null;
}

/** Text with every email and phone number removed (onboarding keeps the rest: the city is wanted). */
export function redactEmailsPhones(text: string): string {
  return String(text ?? "")
    .replace(EMAIL, "[email]")
    .replace(PHONE_LIKE, (m) => {
      const digits = m.replace(/\D/g, "").length;
      return digits >= 10 && digits <= 13 ? "[phone]" : m;
    });
}

/** Resume text with emails, phone numbers and street addresses removed (section 10.6). */
export function redactContact(text: string): string {
  return redactEmailsPhones(text)
    .split("\n")
    .map((line) => (ADDRESS_WORDS.test(line) && /\d/.test(line) && line.length < 200 ? "[address]" : line))
    .join("\n");
}

/** JSON with sorted keys, so the same data always serialises to the same bytes. */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(sort(value));
}

/** The first JSON object in a model's content (fences and stray text tolerated). */
export function extractJson(content: string): unknown {
  const s = String(content ?? "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** A string cut to n characters (null and non-strings become ""). */
export const str = (n: number) => z.preprocess((v) => (typeof v === "string" ? v : v == null ? "" : String(v)), z.string()).transform((s) => s.trim().slice(0, n));
export const strOrNull = (n: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() ? v : null), z.string().nullable()).transform((s) => (s == null ? null : s.trim().slice(0, n)));
/** A list of strings, at most `max` items of at most n characters (anything else becomes []). */
export const strList = (max: number, n: number) =>
  z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []), z.array(z.string())).transform((a) =>
    a.slice(0, max).map((s) => s.trim().slice(0, n))
  );
export const numOrNull = (min: number, max: number) =>
  z.preprocess((v) => (v === null || v === undefined || v === "" ? null : Number(v)), z.number().nullable()).transform((n) =>
    n == null || !Number.isFinite(n) ? null : Math.min(max, Math.max(min, n))
  );
export const oneOf = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(values).catch(fallback as never));
