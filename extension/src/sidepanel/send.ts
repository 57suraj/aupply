/** The side panel talks only to the service worker, which holds the tokens and calls Aupply. */

import type { PanelRequest, PanelResponse } from "../shared/messages";

export class PanelError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

export async function send<T = unknown>(m: PanelRequest): Promise<T> {
  const r = (await chrome.runtime.sendMessage(m)) as PanelResponse<T> | undefined;
  if (!r) throw new PanelError("The extension did not answer. Try again.");
  if (!r.ok) throw new PanelError(r.error, r.code);
  return r.data;
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
