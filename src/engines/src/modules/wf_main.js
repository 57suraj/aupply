/* Wellfound 2/2: the draft scrape of listing pages, the pre-checks before the Apply click
   (company dedup, years, pay, relocation), the modal flow, and window.__aupply.
   Ported from applix wellfound-scraper.js and wellfound-engine.js. */
function wf_main(X) {
  'use strict';
  const { CFG, ME, R, sleep, txt, cut, aid, esc, ST, S, status, wait, SC, ssGet, ssSet, $$, shown, wq, sendBtn, cancel, loc } = X;

  const re = (src) => (src ? new RegExp(src, 'i') : null);
  const scrape = async (first) => {
    for (let i = 0; i < 5; i++) { window.scrollTo(0, document.body.scrollHeight); await sleep(750); }   // more trips the 45s limit
    window.scrollTo(0, 0);
    await sleep(350);
    const acc = first ? { rows: {}, drop: {}, pages: 0 } : ssGet('_draft', { rows: {}, drop: {}, pages: 0 });
    const NEGT = re(SC.negTitle), NEGS = re(SC.negStack), NEGU = re(SC.negSlug), POS = re(SC.pos);
    const seen = new Set();
    let cards = 0;
    for (const a of $$('a[href*="/jobs/"]')) {
      const h = a.getAttribute('href') || '';
      const m = /\/jobs\/(\d+)-([a-z0-9-]*)/.exec(h);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      cards++;
      const title = (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90);
      let jc = a;
      while (jc.parentElement && jc.parentElement.querySelectorAll('a[href*="/jobs/"]').length <= 1) jc = jc.parentElement;
      const jt = (jc.innerText || '').replace(/\s+/g, ' ').trim();
      const idx = title ? jt.indexOf(title) : -1;
      const tail = idx >= 0 ? jt.slice(idx + title.length) : jt;
      const ye = (tail.match(/(\d{1,2})\+? years of exp/i) || [])[1];
      const sal = (tail.match(/₹[\d.]+[KLkl]?\s*[–-]\s*₹[\d.]+[KLkl]?/) || [])[0] || '';
      const pay = R.moneyRange(sal);
      // The URL slug is screened as well as the title ("Full Stack Software Engineer" at
      // /jobs/4677820-full-stack-net-developer).
      let r = null;
      if (NEGT && (NEGT.test(title) || NEGT.test(m[2].replace(/-/g, ' ')))) r = 'title_seniority';
      else if ((NEGS && NEGS.test(title)) || (NEGU && NEGU.test(m[2]))) r = 'title_stack';
      else if (POS && !POS.test(title)) r = 'title_off_target';
      else if (ye && SC.maxYears != null && +ye > SC.maxYears) r = 'years';
      else if (pay && SC.minPay && pay[1] < SC.minPay) r = 'pay';
      if (r) { acc.drop[r] = (acc.drop[r] || 0) + 1; continue; }
      acc.rows[m[1]] = { id: m[1], s: m[2], t: cut(title, 80), ye: ye ? +ye : null, sal: cut(sal, 30) };
    }
    acc.pages++;
    ssSet('_draft', acc);
    return JSON.stringify({ page: acc.pages, cards, kept: Object.keys(acc.rows).length });
  };
  const draft = () => { const acc = ssGet('_draft', { rows: {}, drop: {}, pages: 0 }); ssSet('_draft', null); return JSON.stringify({ jobs: Object.values(acc.rows), dropped: acc.drop, pages: acc.pages }); };

  const company = () => { const m = (document.title || '').match(/ at (.+?)(?:\s+[•|–-]\s+|\s*\||$)/); return m ? m[1].trim() : ''; };

  const hit = () => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    const co = company();
    if (/✓ ?Applied/i.test(t)) return { r: 'ALREADY', co };
    // A second job at a company already applied to never opens its modal.
    if (co && (CFG.known || []).includes(co.toLowerCase())) return { r: 'DUPLICATE_COMPANY', co };
    const ym = t.match(/preferred for this role \((\d{1,2})\+? years/i);
    if (ym && SC.maxYears != null && +ym[1] > SC.maxYears) return { r: 'SKIP_YEARS', co, y: +ym[1] };
    const sm = t.match(/₹([\d.]+)L\s*[–-]\s*₹([\d.]+)L/);
    if (sm && SC.minPay && parseFloat(sm[2]) * 1e5 < SC.minPay) return { r: 'SKIP_LOWPAY', co };
    if (/relocation not allowed/i.test(t) && /on.?site/i.test(t) && ME.city && !new RegExp(esc(ME.city), 'i').test(t.slice(0, 3000))) return { r: 'SKIP_RELOCATION', co };
    if (/not accepting applications from your current location/i.test(t)) return { r: 'BLOCKED_LOC', co };
    const b = $$('button,a').find((x) => /^apply now$|^apply$/i.test(txt(x)));
    if (!b) return { r: 'NO_APPLY', co };
    b.click();
    return { r: 'CLICKED', co };
  };

  const fin = async (co) => {
    const open = () => !!sendBtn() || !!$$('textarea').find(shown);
    // The modal can take 20-30s and is not queryable while it fades in.
    for (let i = 0; i < 16 && !open(); i++) await sleep(800);
    if (!open()) { const b = $$('button,a').find((x) => /^apply now$|^apply$/i.test(txt(x))); if (b) b.click(); for (let i = 0; i < 16 && !open(); i++) await sleep(800); }
    if (!open()) return { r: 'NO_MODAL', co };
    const y2 = document.body.innerText.match(/preferred for this role \((\d{1,2})\+? years/i);
    if (y2 && SC.maxYears != null && +y2[1] > SC.maxYears) { cancel(); return { r: 'SKIP_YEARS', co, y: +y2[1] }; }
    const f = wq();
    await sleep(1100);
    const qa = f.log.slice(0, 16).map((p) => [cut(p[0], 70), cut(p[1], 40)]);
    if (f.prot.length) { cancel(); return { r: 'PROTECTED', co, need: f.prot.map((x) => cut(x, 100)), qa }; }
    if (f.un.length) { cancel(); return { r: 'NEEDS_INPUT', co, need: f.un, qa }; }
    let sb = sendBtn();
    if (!sb) { cancel(); return { r: 'NO_SEND', co, qa }; }
    let L = null;
    if (sb.disabled) {
      L = await loc();
      sb = sendBtn();
      if (!sb || sb.disabled) { cancel(); return { r: 'BLOCKED_LOC', co, loc: L, qa }; }
    }
    sb.scrollIntoView({ block: 'center' });
    await sleep(500);
    sb.click();
    await sleep(5000);
    if (!sendBtn()) return { r: 'SENT', co, qa };
    return { r: /this question is required/i.test(document.body.innerText) ? 'NEEDS_INPUT' : 'UNCONF', co, qa };
  };

  // Apply to the job on this page. Returns at once; poll wait() for the result.
  const apply = (id) => {
    if (S.running) return JSON.stringify({ r: 'RUNNING' });
    const jid = String(id || (location.pathname.match(/\/jobs\/(\d+)/) || [])[1] || '');
    S.running = true; S.phase = 'applying';
    (async () => {
      let res;
      try { const h = hit(); res = h.r === 'CLICKED' ? await fin(h.co) : h; } catch (e) { res = { r: 'ERR', e: cut(e && e.message, 100) }; }
      ST.push(Object.assign({ id: jid, a: aid() }, res, { co: cut(res.co, 40) }));
      S.running = false; S.phase = 'done';
    })();
    return JSON.stringify({ r: 'STARTED', id: jid });
  };

  const selfTest = () => { const fails = R.selfTest(); return JSON.stringify({ ok: !fails.length, v: CFG.v, h: CFG.h, platform: 'wellfound', fails }); };

  window.__aupply = {
    v: CFG.v, h: CFG.h, platform: 'wellfound',
    status, wait, running: () => !!S.running,
    all: () => JSON.stringify(ST.all()),
    scrape, draft, apply,
    selfTest, _t: { A: R.A, pickOpt: R.pickOpt },
  };
  return { ret: selfTest() };
}
