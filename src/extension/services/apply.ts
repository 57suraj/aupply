/**
 * The apply pipeline (section 9): apply leases, form answers, results, tracker, reconcile.
 * Filled in by build phase 5; until then no apply lease is ever issued.
 */

import type { LeaseRow } from "./leases.js";

/** An apply lease that expired (the extension vanished mid-job) counts as ERR for its job. */
export async function settleExpiredApplies(_leases: LeaseRow[]): Promise<void> {}
