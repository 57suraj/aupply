/* LinkedIn draft 3/3: window.__aupply for drafting (sweep, then prescreen). */
function li_dmain(X) {
  'use strict';
  const { CFG, S, ST, status, wait, payMax, trackerCount, sweep, prescreen, yearsOf } = X;

  const selfTest = () => {
    const fails = [];
    if (payMax('Rs 10 - 20 LPA') !== 2000000) fails.push('pay');
    if (yearsOf('3+ years of experience required').minY !== 3) fails.push('years');
    return JSON.stringify({ ok: !fails.length, v: CFG.v, h: CFG.h, platform: 'linkedin', fails });
  };

  window.__aupply = {
    v: CFG.v, h: CFG.h, platform: 'linkedin',
    status, wait, running: () => !!S.running,
    all: () => JSON.stringify(ST.all()),
    sweep, prescreen,
    tracker: trackerCount,
    selfTest, _t: { yearsOf, payMax },
  };
  return { ret: selfTest() };
}
