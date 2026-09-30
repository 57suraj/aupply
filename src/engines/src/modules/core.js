/* Shared browser helpers: the first module of every engine.
   Every module is one factory: it takes the shared context X (CFG, SOURCE and what the
   earlier modules returned) and returns what it adds to X. scripts/build-engines.mjs
   turns each into one small part that Claude pastes on its own. */
function core(X) {
  'use strict';
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
  // The checksum Aupply puts on anything Claude copies into the page (src/engines/index.ts).
  const h31 = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };

  /* Result store. Every result is persisted (so nothing is lost if the page or session
     dies) and handed to Claude once: status()/wait() return only what is new. `running`
     wakes the waiters when it turns false, and push() wakes them when a result lands. */
  function makeStore(key, storage) {
    const S = { seq: 0, cur: 0, items: [], phase: 'idle', info: {} };
    const waiters = new Set();
    // Deferred to a microtask: a runner sets running = false and then phase on the next line.
    const wake = () => { Promise.resolve().then(() => { for (const w of [...waiters]) w(); }); };
    let running = false;
    Object.defineProperty(S, 'running', {
      enumerable: true,
      get: () => running,
      set: (v) => { const was = running; running = !!v; if (was && !running) wake(); },
    });
    try {
      const o = JSON.parse(storage.getItem(key) || 'null');
      if (o && Array.isArray(o.items)) { S.items = o.items.slice(-200); S.seq = o.seq || 0; S.cur = o.cur || 0; }
    } catch (e) { /* storage unavailable: memory only */ }
    const save = () => { try { storage.setItem(key, JSON.stringify({ seq: S.seq, cur: S.cur, items: S.items.slice(-200) })); } catch (e) { /* ignore */ } };
    return {
      S,
      waiters,
      push(rec) { rec.s = ++S.seq; S.items.push(rec); save(); wake(); return rec; },
      pending() { return S.items.some((r) => r.s > S.cur); },
      since() { const out = S.items.filter((r) => r.s > S.cur); S.cur = S.seq; save(); return out; },
      all() { return S.items.slice(); },
    };
  }

  function makeStatus(CFG, ST) {
    const S = ST.S;
    // hid: 1 means the tab is hidden (another tab in front, the window covered or minimized).
    const status = () => JSON.stringify(Object.assign(
      { v: CFG.v, phase: S.phase, running: !!S.running, new: ST.since() },
      document.hidden ? { hid: 1 } : {},
      S.info && Object.keys(S.info).length ? S.info : {}));
    /* Long poll: answers as soon as something new lands or the run stops, at most 35s (the
       browser tool gives up at 45s). One timer plus events, not a loop of one-second sleeps:
       Chrome delays the timers of a throttled tab, and a loop adds that delay to every tick
       (30 Sep: 10s waits answered, 20s and longer timed out). */
    const wait = (ms) => new Promise((resolve) => {
      if (!S.running || ST.pending()) { resolve(status()); return; }
      let done = false;
      let timer = null;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); ST.waiters.delete(finish); resolve(status()); };
      timer = setTimeout(finish, Math.min(+ms || 25000, 35000));
      ST.waiters.add(finish);
    });
    return { status, wait };
  }

  return { sleep, jitter, txt, clean, san, cut, aid, esc, h31, makeStore, makeStatus };
}
