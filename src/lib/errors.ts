/**
 * Application errors shared by the REST API and the MCP tools.
 * AppError carries an HTTP status; the API error handler and the MCP tool
 * wrapper both turn it into a user-facing message.
 */

import type { PostgrestError } from "@supabase/supabase-js";

export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
    public readonly code: string = "bad_request"
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError(`${what} not found.`, 404, "not_found");

/** Map a PostgREST/Postgres error to an AppError with a sensible status. */
export function fromPostgrest(error: PostgrestError): AppError {
  switch (error.code) {
    case "23505":
      return new AppError("A record with these values already exists.", 409, "conflict");
    case "23503":
      return new AppError("A referenced record does not exist.", 400, "invalid_reference");
    case "23514":
    case "23502":
    case "22P02":
    case "22007":
    case "22008":
      return new AppError(`Invalid value: ${error.message}`, 400, "invalid_value");
    case "PGRST116":
      return new AppError("Record not found.", 404, "not_found");
    default:
      console.error("[db]", error);
      return new AppError("Database error.", 500, "db_error");
  }
}

type Result<T> = { data: T; error: PostgrestError | null };

/** Unwrap a query that must return data (lists, .single()). Throws on error. */
export function unwrap<T>(result: Result<T>): NonNullable<T> {
  if (result.error) throw fromPostgrest(result.error);
  if (result.data === null || result.data === undefined) {
    throw new AppError("Expected data but got none.", 500, "db_error");
  }
  return result.data as NonNullable<T>;
}

/** Unwrap a .maybeSingle() query: null means "no such row". */
export function unwrapMaybe<T>(result: Result<T>): T {
  if (result.error) throw fromPostgrest(result.error);
  return result.data;
}

/** For writes/RPCs that return nothing: only surface the error. */
export function check(result: { error: PostgrestError | null }): void {
  if (result.error) throw fromPostgrest(result.error);
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error.";
}
