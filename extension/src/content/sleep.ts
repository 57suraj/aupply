/**
 * Timers that keep their pace in a hidden tab, a port of core.js `sleep`
 * (src/engines/src/modules/core.js). Chrome throttles a page hidden for 5 minutes: a timer set
 * from inside another timer's callback, five deep or more, fires at most about once a minute,
 * which stretched a 2 minute job past the stall limit (30 Sep). Each sleep starts its timer from
 * a message task instead, so every timer stays shallow and a sleep is never shorter than asked.
 * The worker tab is usually hidden (behind other tabs or the Claude app): that is normal.
 */

let hop: MessageChannel | null = null;
const due: [number, () => void][] = [];

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (!hop) {
      hop = new MessageChannel();
      hop.port1.onmessage = () => {
        const next = due.shift();
        if (next) setTimeout(next[1], next[0]);
      };
    }
    due.push([Math.max(0, ms), resolve]);
    hop.port2.postMessage(0);
  });
}

/** Poll fn every 500ms until it answers (truthy) or ms pass; the last answer either way. */
export async function until<T>(fn: () => T, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() >= end) return v;
    await sleep(500);
  }
}

export const jitter = (a: number, b: number) => a + Math.floor(Math.random() * (b - a));
