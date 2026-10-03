/**
 * Questions only the user can answer (section 9.7), AI answers to review (9.9), and the
 * user's stack decisions (8.6).
 *
 * A question is one ext_questions row per user and normalised wording, answered once: the
 * answer is saved as the user's own (confirmed, source 'user'), and every job waiting on it
 * re-enters the queue at once. Stack decisions keep queue_jobs' semantics: keep clears
 * needs_decision (the form then answers No / 0 years for that technology, the resolver's
 * far-technology rule); drop skips the job.
 */

import { getSupabaseClient } from "../../db/supabase.js";
import type { Json } from "../../db/database.types.js";
import { check, unwrap, unwrapMaybe } from "../../lib/errors.js";
import { saveAnswerFromClaude, updateAnswer } from "../../services/answers.js";
import { QUEUE_MAX_AGE_HOURS } from "../../services/automation.js";
import type { DecisionItem, Field, QuestionItem, ReviewItem } from "../contract.js";
import { isSelfKeyed } from "../engine/modules.js";
import { notFoundExt } from "../server/http.js";
import { extAt } from "./queue.js";

const db = () => getSupabaseClient();
type Meta = Record<string, any>;

const decisionRows = (userId: string) =>
  db()
    .from("applications")
    .select("id, external_id, job_title, company_name, match_score, metadata")
    .eq("user_id", userId)
    .eq("platform", "linkedin")
    .eq("status", "discovered")
    .eq("metadata->>needs_decision", "true")
    .gte("created_at", new Date(Date.now() - QUEUE_MAX_AGE_HOURS.linkedin * 3600_000).toISOString());

export async function listDecisions(userId: string): Promise<{ items: DecisionItem[] }> {
  const rows = unwrap(await decisionRows(userId).order("match_score", { ascending: false, nullsFirst: false }).limit(200));
  return {
    items: rows.map((r) => {
      const m = (r.metadata as Meta | null) ?? {};
      return {
        id: r.id, job_id: r.external_id ?? "", title: r.job_title, company: r.company_name,
        wants: Array.isArray(m.sm) ? m.sm : [], score: r.match_score, reasons: Array.isArray(m.ai?.reasons) ? m.ai.reasons : [],
      };
    }),
  };
}

export async function decide(userId: string, items: { id: string; keep: boolean }[]) {
  const rows = unwrap(await decisionRows(userId).in("id", items.map((i) => i.id)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  let kept = 0, dropped = 0;
  for (const item of items) {
    const row = byId.get(item.id);
    if (!row) continue;
    const metadata = { ...((row.metadata as Meta) ?? {}), needs_decision: false, ...extAt() } as Json;
    check(
      await db()
        .from("applications")
        .update(item.keep ? { metadata } : { metadata, status: "skipped", status_reason: "stack_declined: the user chose not to apply" })
        .eq("id", row.id)
        .eq("user_id", userId)
    );
    if (item.keep) kept++;
    else dropped++;
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Questions only the user can answer
// ---------------------------------------------------------------------------

const realOptions = (f: Field) =>
  (f.options ?? []).filter((o, i) => !f.option_values_empty?.[i] && o.trim() && !/^(select|choose|--|please)/i.test(o.trim()));

/** Words that carry meaning (four letters or more), for grouping rephrased questions. */
const words = (norm: string) => new Set(norm.split(" ").filter((w) => w.length >= 4));
/** Two wordings of one question: most of their meaningful words in common (BUGS.md B3). */
const ALIAS_MIN = 0.6;
function similar(a: string, b: string) {
  const x = words(a), y = words(b);
  const both = [...x].filter((w) => y.has(w)).length;
  return both / Math.max(1, new Set([...x, ...y]).size);
}
const sameShape = (opts: unknown, options: string[]) =>
  JSON.stringify(((Array.isArray(opts) ? opts : []) as string[]).map((o) => o.toLowerCase()).sort()) === JSON.stringify(options.map((o) => o.toLowerCase()).sort());

/** An open question asking the same thing in other words (same kind of field, same options). */
async function aliasOf(userId: string, q: { norm: string; key: string | null; field: Field }, options: string[]) {
  if (q.key) return null; // a keyed fact is one question already, whatever the wording
  const open = unwrap(
    await db()
      .from("ext_questions")
      .select("id, question_norm, field_type, options, metadata")
      .eq("user_id", userId)
      .eq("status", "open")
      .is("key", null)
      .order("last_seen_at", { ascending: false })
      .limit(100)
  );
  const textual = (t: string | null) => !["radio", "select", "checkbox_group"].includes(t ?? "");
  return (
    open.find((o) => textual(o.field_type) === textual(q.field.kind) && (textual(q.field.kind) || sameShape(o.options, options)) && similar(o.question_norm, q.norm) >= ALIAS_MIN) ??
    null
  );
}

/** Record a question a job is waiting on: one row per wording (a repeat bumps it and adds the job);
    a rephrasing of an open question joins it as an alias, so the user answers once (BUGS.md B3). */
export async function noteQuestion(
  userId: string,
  q: { question: string; norm: string; key: string | null; kind: "needs_input" | "protected"; field: Field; applicationId: string | null }
): Promise<string> {
  const options = realOptions(q.field);
  for (let attempt = 0; attempt < 2; attempt++) {
    let cur = unwrapMaybe(
      await db().from("ext_questions").select("id, status, waiting, times_seen, key, metadata").eq("user_id", userId).eq("question_norm", q.norm).maybeSingle()
    );
    if (!cur && q.kind === "needs_input") {
      const alias = await aliasOf(userId, q, options);
      if (alias) {
        const meta = (alias.metadata as Meta | null) ?? {};
        const aliases = (meta.aliases ?? []) as { question: string; norm: string }[];
        if (!aliases.some((a) => a.norm === q.norm)) aliases.push({ question: q.question.slice(0, 2000), norm: q.norm.slice(0, 2000) });
        check(await db().from("ext_questions").update({ metadata: { ...meta, aliases: aliases.slice(-20) } as Json }).eq("id", alias.id).eq("user_id", userId));
        cur = unwrapMaybe(await db().from("ext_questions").select("id, status, waiting, times_seen, key, metadata").eq("id", alias.id).eq("user_id", userId).maybeSingle());
      }
    }
    if (cur) {
      const waiting = ((cur.waiting as string[] | null) ?? []).filter(Boolean);
      if (q.applicationId && !waiting.includes(q.applicationId)) waiting.push(q.applicationId);
      check(
        await db()
          .from("ext_questions")
          .update({
            times_seen: cur.times_seen + 1, last_seen_at: new Date().toISOString(), waiting: waiting.slice(-200) as Json,
            // Seen again although answered: the answer did not fit this form (formAnswers uses the
            // user's answer first), so it is open again.
            status: cur.status === "answered" ? "open" : cur.status,
            kind: q.kind, field_type: q.field.kind, options: (options.length ? options : null) as Json,
            key: cur.key && isSelfKeyed(cur.key) ? cur.key : q.key,
          })
          .eq("id", cur.id)
          .eq("user_id", userId)
      );
      return cur.id;
    }
    const { data, error } = await db()
      .from("ext_questions")
      .insert({
        user_id: userId, question: q.question.slice(0, 2000), question_norm: q.norm.slice(0, 2000), key: q.key, kind: q.kind,
        field_type: q.field.kind, options: (options.length ? options : null) as Json, waiting: (q.applicationId ? [q.applicationId] : []) as Json,
      })
      .select("id")
      .single();
    if (!error && data) return data.id;
    if (error?.code !== "23505") throw error;
  }
  throw new Error("could not record the question");
}

export async function listQuestions(userId: string): Promise<{ items: QuestionItem[] }> {
  const rows = unwrap(
    await db()
      .from("ext_questions")
      .select("id, question, kind, key, field_type, options, waiting, times_seen")
      .eq("user_id", userId)
      .eq("status", "open")
      .order("last_seen_at", { ascending: false })
      .limit(100)
  );
  return {
    items: rows.map((r) => ({
      id: r.id, question: r.question, kind: r.kind as QuestionItem["kind"], key: r.key, field_type: r.field_type,
      options: Array.isArray(r.options) ? (r.options as string[]) : null,
      waiting_count: Array.isArray(r.waiting) ? r.waiting.length : 0, times_seen: r.times_seen,
    })),
  };
}

async function questionOf(userId: string, id: string) {
  const q = unwrapMaybe(await db().from("ext_questions").select("id, question, key, kind, status, waiting, metadata").eq("id", id).eq("user_id", userId).maybeSingle());
  if (!q) throw notFoundExt("Question");
  return q;
}

/** Save the user's answer as their own (confirmed, source 'user'). */
async function saveUsers(userId: string, question: string, answer: string, key: string | null) {
  const saved = await saveAnswerFromClaude(userId, { question, answer, key, confirmed_by_user: true });
  check(await db().from("answers").update({ source: "user" }).eq("id", saved.answer.id).eq("user_id", userId));
  return saved.answer.id as string;
}

/** The user's answer: saved as their own under every wording of the question, and every job waiting
    on it back in the queue. A key is used only when the resolver reads the answer back from it
    (BUGS.md B2); otherwise each wording gets its own keyless answer, so two questions can never
    share, or overwrite, one answer row. */
export async function answerQuestion(userId: string, id: string, answer: string) {
  const q = await questionOf(userId, id);
  const key = q.key && isSelfKeyed(q.key) ? q.key : null;
  const answerId = await saveUsers(userId, q.question, answer, key);
  const aliases = ((((q.metadata as Meta | null) ?? {}).aliases ?? []) as { question: string }[]).filter((a) => a.question);
  for (const a of aliases) await saveUsers(userId, a.question, answer, null);
  const saved = { answer: { id: answerId } };
  check(
    await db()
      .from("ext_questions")
      .update({ status: "answered", answer_id: saved.answer.id, answered_at: new Date().toISOString() })
      .eq("id", q.id)
      .eq("user_id", userId)
  );
  let released = 0;
  const waiting = ((q.waiting as string[] | null) ?? []).filter(Boolean);
  if (waiting.length) {
    const apps = unwrap(await db().from("applications").select("id, metadata").eq("user_id", userId).in("id", waiting));
    for (const a of apps) {
      const meta = { ...((a.metadata as Meta | null) ?? {}) };
      if (!Array.isArray(meta.needs_input) || !meta.needs_input.includes(q.id)) continue;
      meta.needs_input = meta.needs_input.filter((x: string) => x !== q.id);
      if (!meta.needs_input.length) {
        delete meta.needs_input;
        released++;
      }
      check(await db().from("applications").update({ metadata: { ...meta, ...extAt() } as Json }).eq("id", a.id).eq("user_id", userId));
    }
  }
  return { ok: true as const, released };
}

/** "Skip the jobs that need this": every waiting job still queued is skipped. */
export async function dismissQuestion(userId: string, id: string) {
  const q = await questionOf(userId, id);
  check(await db().from("ext_questions").update({ status: "dismissed" }).eq("id", q.id).eq("user_id", userId));
  const waiting = ((q.waiting as string[] | null) ?? []).filter(Boolean);
  let skipped = 0;
  if (waiting.length) {
    const rows = unwrap(await db().from("applications").select("id, metadata").eq("user_id", userId).eq("status", "discovered").in("id", waiting));
    for (const r of rows) {
      check(
        await db()
          .from("applications")
          .update({ status: "skipped", status_reason: `needs your answer: ${q.question}`.slice(0, 500), metadata: { ...((r.metadata as Meta | null) ?? {}), ...extAt() } as Json })
          .eq("id", r.id)
          .eq("user_id", userId)
      );
      skipped++;
    }
  }
  return { ok: true as const, skipped };
}

/** Questions among `ids` the user dismissed (a job waiting on one is skipped). */
export async function dismissedAmong(userId: string, ids: string[]) {
  if (!ids.length) return [];
  return unwrap(await db().from("ext_questions").select("id, question").eq("user_id", userId).eq("status", "dismissed").in("id", ids));
}

/** Of `ids`, the ones that are this user's and still open. */
export async function openAmong(userId: string, ids: string[]) {
  if (!ids.length) return [];
  return unwrap(await db().from("ext_questions").select("id").eq("user_id", userId).eq("status", "open").in("id", ids)).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// AI answers to review (section 9.9)
// ---------------------------------------------------------------------------

export async function listReview(userId: string): Promise<{ items: ReviewItem[] }> {
  const rows = unwrap(
    await db()
      .from("answers")
      .select("id, question, answer, created_at")
      .eq("user_id", userId)
      .eq("status", "provisional")
      .eq("metadata->>origin", "extension_ai")
      .order("created_at", { ascending: false })
      .limit(100)
  );
  return { items: rows };
}

export async function confirmAnswer(userId: string, id: string, answer?: string) {
  const row = await updateAnswer(userId, id, { ...(answer ? { answer } : {}), status: "confirmed" });
  return { id: row.id, question: row.question, answer: row.answer, created_at: row.created_at };
}
