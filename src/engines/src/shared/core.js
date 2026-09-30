/* Shared browser helpers, included into every engine by scripts/build-engines.mjs.
   Plain JavaScript that runs inside the engine's IIFE on the job site's page. */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a));
const txt = (e) => ((e && (e.innerText || e.textContent)) || '').replace(/\s+/g, ' ').trim();
const clean = (s) => (s ? String(s)
  .replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim() : '');
/* The Chrome extension refuses tool output that looks like a URL or query string, so
   every string an engine returns goes through san(). */
const san = (s) => String(s == null ? '' : s).replace(/https?:\/\/\S+/gi, ' ').replace(/[?&=#]/g, ' ').replace(/\s+/g, ' ').trim();
const cut = (s, n) => san(s).slice(0, n);
const aid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Result store. Every result is persisted (so nothing is lost if the page or session
   dies) and handed to Claude once: status()/wait() return only what is new. */
function makeStore(key, storage) {
  const S = { seq: 0, cur: 0, items: [], phase: 'idle', running: false, info: {} };
  try {
    const o = JSON.parse(storage.getItem(key) || 'null');
    if (o && Array.isArray(o.items)) { S.items = o.items.slice(-200); S.seq = o.seq || 0; S.cur = o.cur || 0; }
  } catch (e) { /* storage unavailable: memory only */ }
  const save = () => { try { storage.setItem(key, JSON.stringify({ seq: S.seq, cur: S.cur, items: S.items.slice(-200) })); } catch (e) { /* ignore */ } };
  return {
    S,
    push(rec) { rec.s = ++S.seq; S.items.push(rec); save(); return rec; },
    pending() { return S.items.some((r) => r.s > S.cur); },
    since() { const out = S.items.filter((r) => r.s > S.cur); S.cur = S.seq; save(); return out; },
    all() { return S.items.slice(); },
  };
}

function makeStatus(CFG, ST) {
  const S = ST.S;
  const status = () => JSON.stringify(Object.assign(
    { v: CFG.v, phase: S.phase, running: !!S.running, new: ST.since() },
    S.info && Object.keys(S.info).length ? S.info : {}));
  /* Long poll: returns as soon as something new lands or the run stops, at most 40s
     (the browser tool times out at 45s). */
  const wait = async (ms) => {
    const end = Date.now() + Math.min(+ms || 30000, 40000);
    while (Date.now() < end && S.running && !ST.pending()) await sleep(1000);
    return status();
  };
  return { status, wait };
}
