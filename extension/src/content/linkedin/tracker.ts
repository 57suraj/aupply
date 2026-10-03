/** LinkedIn's own Applied count on the tracker page (li_base `trackerCount`), waited for up to 10s. */

import { until } from "../sleep";
import { trackerCount } from "./dom";

export async function readTracker(): Promise<{ count: number | null }> {
  const count = await until(trackerCount, 10_000);
  return { count: count ?? null };
}
