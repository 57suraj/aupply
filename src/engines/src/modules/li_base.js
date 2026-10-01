/* LinkedIn base: rate limits, the result store and the tracker count. Both LinkedIn
   engines (the draft and the apply) load it, so a page that drafted and then applies
   keeps it. Ported from applix 05-SCRIPTS-linkedin-engine.js (30 Sep 2026, live-tested)
   with the personal values moved to CFG. Loaded on /jobs-tracker/ and never eval'd
   (LinkedIn's CSP blocks eval on job pages, and on the tracker page after the first
   load). */
function li_base(X) {
  'use strict';
  const { CFG, makeStore, makeStatus } = X;
  /* Rate limits. Fixed here on purpose: no tool input can shorten them
     (docs/automation-tools.md, "Rate limits"). */
  const P = { page: 6000, pageSlow: 8000, gapMin: 15000, gapMax: 30000, rlPause: 300000, search: 1000, jd: 1500, jdPause: 600000, jobMax: 240000, card: 15000, modal: 15000 };
  const ST = makeStore('__aupply_li_' + (CFG.u || 'x'), localStorage);
  const S = ST.S;
  S.running = false;
  const { status, wait } = makeStatus(CFG, ST);
  const trackerCount = () => { const m = (document.body.innerText || '').match(/Applied\s*[·•:-]\s*([\d,]+)/i); return m ? +m[1].replace(/,/g, '') : null; };

  return { P, ST, S, status, wait, trackerCount };
}
