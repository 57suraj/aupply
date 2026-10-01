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

  /* The Chrome extension cuts a JavaScript answer at 1000 characters (live run 1 Oct: the
     sweep's ids and the prescreen's drops came back cut off, so they could not be passed
     on as-is). No status answer exceeds ANSWER_MAX: push() trims a result to ITEM_MAX
     (its longest list loses entries, and cut:1 says so), status() hands out only the
     results that fit and says how many are left in `more`, and a producer with a big
     output (a sweep's ids, a prescreen's keep and drop) pushes it in chunks(). */
  const ANSWER_MAX = 900;
  const ITEM_MAX = 700;
  const size = (o) => JSON.stringify(o).length;
  const fit = (rec) => {
    while (size(rec) > ITEM_MAX) {
      const k = Object.keys(rec).filter((x) => Array.isArray(rec[x]) && rec[x].length).sort((a, b) => size(rec[b]) - size(rec[a]))[0];
      if (!k) break;
      rec[k].pop();
      rec.cut = 1;
    }
    return rec;
  };
  const chunks = (list, room) => {
    const out = [];
    let cur = [];
    for (const x of list) { if (cur.length && size(cur) + size(x) + 1 > room) { out.push(cur); cur = []; } cur.push(x); }
    if (cur.length) out.push(cur);
    return out;
  };

  /* Result store. Every result is persisted (so nothing is lost if the page or session
     dies) and handed to Claude once: status()/wait() return only what is new, as much of
     it as fits in one answer. `running` wakes the waiters when it turns false, and push()
     wakes them when a result lands. */
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
      push(rec) { rec.s = ++S.seq; S.items.push(fit(rec)); save(); wake(); return rec; },
      pending() { return S.items.some((r) => r.s > S.cur); },
      // The results not yet handed out, oldest first, up to `room` characters (at least one).
      since(room) {
        const out = [];
        let used = 0;
        for (const r of S.items) {
          if (r.s <= S.cur) continue;
          const n = size(r) + 1;
          if (out.length && used + n > room) break;
          out.push(r);
          used += n;
          S.cur = r.s;
        }
        save();
        return out;
      },
      left() { return S.items.filter((r) => r.s > S.cur).length; },
      all() { return S.items.slice(); },
    };
  }

  function makeStatus(CFG, ST) {
    const S = ST.S;
    // hid: 1 means the tab is hidden (another tab in front, the window covered or minimized).
    // more: N means N results did not fit in this answer; the next call returns them at once.
    const status = () => {
      const head = { v: CFG.v, phase: S.phase, running: !!S.running };
      const tail = Object.assign(document.hidden ? { hid: 1 } : {}, S.info && Object.keys(S.info).length ? S.info : {});
      const items = ST.since(ANSWER_MAX - size(head) - size(tail) - 30);
      const more = ST.left();
      return JSON.stringify(Object.assign(head, { new: items }, more ? { more } : {}, tail));
    };
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

  return { sleep, jitter, txt, clean, san, cut, aid, esc, h31, chunks, makeStore, makeStatus };
}
