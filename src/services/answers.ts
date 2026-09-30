/**
 * Reusable answer library.
 *
 * Rule carried over from applix: an answer the user confirmed is never
 * overwritten by something Claude inferred. Claude's own saves are
 * 'provisional' unless the user stated the answer in the conversation.
 */

import type { z } from "zod";
import { getSupabaseClient } from "../db/supabase.js";
import type { Json } from "../db/database.types.js";
import { check, notFound, unwrap, unwrapMaybe } from "../lib/errors.js";
import type { AnswerInput, AnswerPatch } from "../domain/schemas.js";

const db = () => getSupabaseClient();

export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listAnswers(
  userId: string,
  filters: { q?: string; category?: string; status?: string; keyed?: boolean } = {}
) {
  let query = db().from("answers").select("*").eq("user_id", userId);
  if (filters.q) query = query.ilike("question", `%${escapeLike(filters.q)}%`);
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.keyed !== undefined) {
    query = filters.keyed ? query.not("key", "is", null) : query.is("key", null);
  }
  return unwrap(await query.order("updated_at", { ascending: false }).limit(500));
}

/** Saved answers and past application answers that resemble `question`. */
export async function findSimilarAnswers(userId: string, question: string, limit = 5) {
  return unwrap(
    await db().rpc("find_similar_answers", { p_user_id: userId, p_query: question, p_limit: limit })
  );
}

export async function createAnswer(
  userId: string,
  input: z.infer<typeof AnswerInput>,
  source: "user" | "claude" | "import" = "user"
) {
  return unwrap(
    await db()
      .from("answers")
      .insert({ ...input, metadata: input.metadata as Json | undefined, user_id: userId, source })
      .select("*")
      .single()
  );
}

export async function updateAnswer(userId: string, id: string, patch: z.infer<typeof AnswerPatch>) {
  const row = unwrapMaybe(
    await db()
      .from("answers")
      .update({ ...patch, metadata: patch.metadata as Json | undefined })
      .eq("id", id)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle()
  );
  if (!row) throw notFound("Answer");
  return row;
}

export async function deleteAnswer(userId: string, id: string) {
  const rows = unwrap(await db().from("answers").delete().eq("id", id).eq("user_id", userId).select("id"));
  if (!rows.length) throw notFound("Answer");
}

/**
 * Upsert from Claude: match by key, else by the exact question (case-insensitive).
 * Refuses to replace a confirmed answer with a provisional one.
 */
export async function saveAnswerFromClaude(
  userId: string,
  input: {
    question: string;
    answer: string;
    key?: string | null;
    category?: string | null;
    confirmed_by_user?: boolean;
  }
) {
  const status = input.confirmed_by_user ? "confirmed" : "provisional";
  let existingQuery = db().from("answers").select("*").eq("user_id", userId);
  existingQuery = input.key
    ? existingQuery.eq("key", input.key)
    : existingQuery.ilike("question", escapeLike(input.question.trim()));
  const existing = unwrapMaybe(await existingQuery.limit(1).maybeSingle());

  if (existing && existing.status === "confirmed" && status === "provisional") {
    return {
      saved: false,
      reason: "A confirmed answer already exists and was not overwritten. Ask the user if it should change.",
      answer: existing,
    };
  }

  if (existing) {
    const updated = unwrap(
      await db()
        .from("answers")
        .update({
          question: input.question,
          answer: input.answer,
          status,
          source: "claude",
          ...(input.category !== undefined ? { category: input.category } : {}),
        })
        .eq("id", existing.id)
        .eq("user_id", userId)
        .select("*")
        .single()
    );
    return { saved: true, updated: true, answer: updated };
  }

  const created = await createAnswer(
    userId,
    { question: input.question, answer: input.answer, key: input.key ?? null, category: input.category ?? null, status },
    "claude"
  );
  return { saved: true, updated: false, answer: created };
}

export async function markAnswersUsed(userId: string, answerIds: string[]) {
  if (!answerIds.length) return;
  check(await db().rpc("mark_answers_used", { p_user_id: userId, p_answer_ids: answerIds }));
}
