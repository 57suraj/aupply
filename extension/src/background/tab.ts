/**
 * The worker tab (section 11.6): one dedicated LinkedIn tab per run, in an orange "Aupply" tab
 * group, never discarded by Memory Saver, usually hidden behind other tabs (that is normal and
 * must work). Real navigations between jobs (decision E12). Trusted clicks through the optional
 * debugger permission, attached only for the click.
 */

import { allowed } from "../shared/allowlist";
import { log } from "./log";
import { session } from "./store";

export async function workerTab(): Promise<chrome.tabs.Tab | null> {
  const id = await session.get("workerTabId");
  if (id == null) return null;
  try {
    return await chrome.tabs.get(id);
  } catch {
    return null;
  }
}

/** Navigate the worker tab (creating it on first use). Refuses any URL outside the allowlist. */
export async function navigateWorker(url: string): Promise<number> {
  if (!allowed(url)) throw new Error("refused a URL outside the allowlist");
  const existing = await workerTab();
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { url, autoDiscardable: false });
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.id == null) throw new Error("could not open a tab");
  await session.set("workerTabId", tab.id);
  try {
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
    const group = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(group, { title: "Aupply", color: "orange", collapsed: false });
  } catch (err) {
    log("tab", "group failed", String(err).slice(0, 80));
  }
  log("tab", "worker tab opened");
  return tab.id;
}

export async function reloadWorker() {
  const t = await workerTab();
  if (t?.id != null) await chrome.tabs.reload(t.id).catch(() => undefined);
}

export const debuggerGranted = () => chrome.permissions.contains({ permissions: ["debugger"] }).catch(() => false);

/** A real mouse click at viewport coordinates (CSS pixels) in the worker tab. */
export async function trustedClick(tabId: number, x: number, y: number): Promise<{ ok: boolean; reason?: string }> {
  if (!(await debuggerGranted())) return { ok: false, reason: "no_permission" };
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (err) {
    return { ok: false, reason: `attach: ${String(err).slice(0, 80)}` };
  }
  try {
    const base = { x, y, button: "left", clickCount: 1 };
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    log("click", "trusted click sent");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `click: ${String(err).slice(0, 80)}` };
  } finally {
    await chrome.debugger.detach(target).catch(() => undefined);
  }
}
