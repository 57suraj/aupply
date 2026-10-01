/* LinkedIn apply 1/4: the page readers for the Easy Apply modal and the job page.
   Ported from applix 05-SCRIPTS-linkedin-engine.js (30 Sep 2026, live-tested) with the
   answer chain replaced by the shared resolver. The runner moves between jobs by SPA
   navigation, so the page, and the engine, stay alive for the whole queue. */
function li_dom(X) {
  'use strict';
  const { txt, cut } = X;
  const CONSENT = /consent|i agree|agree to|privacy notice|privacy policy|acknowledge|i understand|declare|certify|attest|terms and conditions|data processing|gdpr/i;
  const NEVERTICK = /marketing|promotion|newsletter|text message|\bsms\b|notify me|updates about|follow|subscribe/i;

  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const navBtn = () => $$('button').find((b) => /^(next|review|submit application|continue)$/i.test(txt(b)));
  // No role="dialog" and obfuscated classes: anchor the modal from its nav button.
  const modal = () => {
    const nb = navBtn();
    if (!nb) return null;
    let p = nb;
    for (let i = 0; i < 14 && p; i++) {
      p = p.parentElement;
      if (!p) break;
      if (/Apply to /.test(p.innerText || '') && p.querySelector('input,select,textarea,button')) return p;
    }
    return nb.closest('form') || nb.parentElement;
  };
  // Only trust a label from a container holding exactly one control; the old walk
  // read a neighbour's label and typed a first name into a city field.
  const lab = (el) => {
    let l = '';
    const ref = el.getAttribute('aria-labelledby');
    if (ref) { const n = document.getElementById(ref); if (n) l = n.innerText || ''; }
    if (!l && el.labels && el.labels[0]) l = el.labels[0].innerText || '';
    if (!l && el.id) { const x = document.querySelector('label[for="' + el.id + '"]'); if (x) l = x.innerText || ''; }
    if (!l) {
      let p = el.parentElement;
      for (let i = 0; i < 4 && p && !l; i++) {
        if (p.querySelectorAll('input,select,textarea').length === 1) { const q = p.querySelector('label,legend'); if (q) l = q.innerText || ''; }
        p = p.parentElement;
      }
    }
    if (!l) l = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '';
    return l.replace(/\s+/g, ' ').trim().slice(0, 160);
  };
  const fields = () => { const m = modal(); if (!m) return []; return $$('input,select,textarea', m).filter((e) => e.type !== 'hidden' && vis(e) && !/select language/i.test(lab(e))); };
  const optText = (e) => {
    if (e.id) { const x = document.querySelector('label[for="' + e.id + '"]'); if (x && (x.innerText || '').trim()) return x.innerText.trim(); }
    let p = e;
    for (let i = 0; i < 5 && p; i++) { p = p.parentElement; if (!p) continue; const t = (p.innerText || '').trim(); if (t && t.length < 40) return t; }
    return '';
  };
  const qOf = (els) => {
    const fs = els[0].closest('fieldset');
    let q = '';
    if (fs) { const lg = fs.querySelector('legend'); if (lg) q = lg.innerText || ''; if (!q && fs.previousElementSibling) q = fs.previousElementSibling.innerText || ''; }
    if (!q) {
      let c = els[0];
      while (c.parentElement && !els.every((e) => c.contains(e))) c = c.parentElement;
      let p = c;
      for (let i = 0; i < 4 && p && !q; i++) { let t = (p.innerText || '').replace(/\s+/g, ' ').trim(); t = t.replace(/(\s*(Yes|No))+\s*$/, ''); if (t.length >= 15) q = t; p = p.parentElement; }
    }
    return q.replace(/\s+/g, ' ').replace(/\*$/, '').trim().slice(0, 160);
  };
  const radios = () => {
    const m = modal();
    if (!m) return [];
    const g = {};
    $$('input[type=radio]', m).forEach((e) => { const n = e.name || 'x'; (g[n] = g[n] || []).push(e); });
    return Object.keys(g).map((n) => { const els = g[n]; const c = els.find((e) => e.checked); return { q: qOf(els), els, opts: els.map(optText), val: c ? optText(c) || 'selected' : null }; });
  };
  const progress = () => { const m = modal(); return ((m ? m.innerText || '' : '').match(/(\d+)\s*\/\s*(\d+)\s*pages|\d+%/) || [])[0] || ''; };
  const setVal = (el, v) => {
    const P2 = el.tagName === 'SELECT' ? HTMLSelectElement : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(P2.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const clickText = (t) => { const b = $$('button').find((x) => txt(x).toLowerCase() === t.toLowerCase()); if (!b) return false; b.click(); return true; };
  const deepAll = (sel) => {
    const out = [];
    const walk = (r) => { if (!r || !r.querySelectorAll) return; try { out.push(...r.querySelectorAll(sel)); } catch (e) { /* ignore */ } r.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); }); };
    walk(document);
    return out;
  };
  // The success confirmation and the cap dialog render in shadow roots.
  const deepText = () => {
    let out = '';
    const walk = (r) => { if (!r) return; try { out += ' ' + (r.textContent || ''); } catch (e) { /* ignore */ } if (r.querySelectorAll) r.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); }); };
    walk(document);
    return out.replace(/\s+/g, ' ');
  };
  const sentTo = () => { const m = deepText().match(/application was sent to ([^!]{1,45})/i); return m ? m[1].trim() : null; };
  const dismiss = () => { const b = deepAll('button').find((x) => /^(not now|done|dismiss|no thanks)$/i.test((x.innerText || x.textContent || '').trim())); if (b) b.click(); };
  const limitHit = () => /reached today'?s easy apply limit|easy apply limit/i.test(document.body.innerText + ' ' + deepText());
  /* The job page's apply control, not clicked: Easy Apply (sometimes an <a>, not a <button>)
     or the company-site Apply. null until the top card has rendered. */
  const applyControl = () => {
    const all = deepAll('button,a');
    let b = all.find((x) => /^easy apply$/i.test(txt(x)));
    if (!b) b = all.find((x) => /easy apply to this job/i.test(x.getAttribute('aria-label') || ''));
    if (!b) b = all.find((x) => /^easy apply/i.test(txt(x)));
    if (b) return { easy: true };
    b = all.find((x) => /^apply$/i.test(txt(x)) || /on company website/i.test(x.getAttribute('aria-label') || ''));
    return b ? { easy: false } : null;
  };
  // Clicks Easy Apply; false when the page shows none.
  const easy = () => {
    const c = applyControl();
    if (!c || !c.easy) return false;
    const all = deepAll('button,a');
    const b = all.find((x) => /^easy apply$/i.test(txt(x))) || all.find((x) => /easy apply to this job/i.test(x.getAttribute('aria-label') || '')) || all.find((x) => /^easy apply/i.test(txt(x)));
    b.click();
    return true;
  };
  const closed = () => /no longer accepting applications/i.test(document.body.innerText);
  const alreadyApplied = () => /\byou applied\b|\bapplied \d+ (second|minute|hour|day|week|month)s? ago\b|application submitted/i.test(document.body.innerText);
  const pageTitle = () => { const p = (document.title || '').split('|').map((x) => x.trim()); return { t: cut(p[0], 70), co: cut(p[1], 40) }; };

  return { CONSENT, NEVERTICK, $$, vis, navBtn, modal, lab, fields, optText, radios, progress, setVal, clickText, deepAll, sentTo, dismiss, limitHit, applyControl, easy, closed, alreadyApplied, pageTitle };
}
