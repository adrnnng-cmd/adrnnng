// Tom DeMark's TD Sequential: Setup (9) and Countdown (13).
//
// Setup     A buy setup is `setupLength` consecutive closes below the close `lookback` bars earlier,
//           started by a bearish price flip (prior bar closed above the close lookback+1 bars back).
//           Sell setups mirror this. Perfection: a buy 9 is perfected when the low of bar 8 or 9 is
//           at or below the lows of bars 6 and 7 (sell: highs at or above).
// Countdown Starts on the bar that completes a setup (that bar may count). Buy countdown counts
//           closes at or below the low two bars earlier; bars need not be consecutive. Bar 13 must
//           also have a low at or below the close of countdown bar 8, otherwise it is deferred ("+")
//           until a bar qualifies. A buy countdown is cancelled when a sell setup completes or when
//           price closes above TDST resistance (the highest high of the buy setup). Optional
//           recycling restarts the countdown when a new same-direction setup completes.

export function tdSequential(bars, opts = {}) {
  const lookback = opts.lookback ?? 4;
  const setupLength = opts.setupLength ?? 9;
  const cdLength = opts.countdownLength ?? 13;
  const cdLookback = opts.countdownLookback ?? 2;
  const requireFlip = opts.requireFlip ?? true;
  const cancelOnTdst = opts.cancelOnTdst ?? true;
  const recycle = opts.recycle ?? false;

  const n = bars.length;
  const c = bars.map((b) => b.close);
  const h = bars.map((b) => b.high);
  const l = bars.map((b) => b.low);
  const mk = (v) => new Array(n).fill(v);
  const out = {
    buySetup: mk(0),
    sellSetup: mk(0),
    buySetupDone: mk(false),
    sellSetupDone: mk(false),
    buyPerfect: mk(false),
    sellPerfect: mk(false),
    buyCountdown: mk(0),
    sellCountdown: mk(0),
    buy13: mk(false),
    sell13: mk(false),
    buyDeferred: mk(false),
    sellDeferred: mk(false),
    tdstResistance: mk(null),
    tdstSupport: mk(null),
  };

  let bs = 0;
  let ss = 0;
  const cd = {
    buy: { active: false, count: 0, close8: null, tdst: null },
    sell: { active: false, count: 0, close8: null, tdst: null },
  };
  let res = null;
  let sup = null;

  for (let i = lookback; i < n; i++) {
    const prevFlipBuy = i - 1 - lookback >= 0 && c[i - 1] > c[i - 1 - lookback];
    const prevFlipSell = i - 1 - lookback >= 0 && c[i - 1] < c[i - 1 - lookback];

    if (c[i] < c[i - lookback]) bs = bs > 0 ? bs + 1 : !requireFlip || prevFlipBuy ? 1 : 0;
    else bs = 0;
    if (c[i] > c[i - lookback]) ss = ss > 0 ? ss + 1 : !requireFlip || prevFlipSell ? 1 : 0;
    else ss = 0;
    out.buySetup[i] = bs;
    out.sellSetup[i] = ss;

    if (bs === setupLength) {
      out.buySetupDone[i] = true;
      const a = Math.min(l[i - 3], l[i - 2]);
      out.buyPerfect[i] = l[i] <= a || l[i - 1] <= a;
      res = Math.max(...h.slice(i - setupLength + 1, i + 1));
      startCountdown(cd.buy, res);
      cd.sell.active = false;
    }
    if (ss === setupLength) {
      out.sellSetupDone[i] = true;
      const a = Math.max(h[i - 3], h[i - 2]);
      out.sellPerfect[i] = h[i] >= a || h[i - 1] >= a;
      sup = Math.min(...l.slice(i - setupLength + 1, i + 1));
      startCountdown(cd.sell, sup);
      cd.buy.active = false;
    }
    out.tdstResistance[i] = res;
    out.tdstSupport[i] = sup;

    step(cd.buy, i, 1);
    step(cd.sell, i, -1);
  }
  return out;

  function startCountdown(state, tdst) {
    if (state.active && !recycle) return;
    state.active = true;
    state.count = 0;
    state.close8 = null;
    state.tdst = tdst;
  }

  function step(state, i, dir) {
    if (!state.active || i < cdLookback) return;
    if (cancelOnTdst && (dir === 1 ? c[i] > state.tdst : c[i] < state.tdst)) {
      state.active = false;
      return;
    }
    const qualifies = dir === 1 ? c[i] <= l[i - cdLookback] : c[i] >= h[i - cdLookback];
    if (!qualifies) return;
    if (state.count < cdLength - 1) {
      state.count++;
      if (state.count === 8) state.close8 = c[i];
      (dir === 1 ? out.buyCountdown : out.sellCountdown)[i] = state.count;
      return;
    }
    const ok = state.close8 == null || (dir === 1 ? l[i] <= state.close8 : h[i] >= state.close8);
    if (ok) {
      state.count = cdLength;
      (dir === 1 ? out.buyCountdown : out.sellCountdown)[i] = cdLength;
      (dir === 1 ? out.buy13 : out.sell13)[i] = true;
      state.active = false;
    } else {
      (dir === 1 ? out.buyDeferred : out.sellDeferred)[i] = true;
    }
  }
}

const UP = '#34d399';
const DOWN = '#fb7185';

export default {
  id: 'td-sequential',
  name: 'TD Sequential',
  short: 'TD 9 / 13',
  summary: 'DeMark exhaustion counts: buy on a buy Setup 9 and/or Countdown 13, exit (or reverse) on the sell-side signal.',
  tags: ['DeMark', 'Counter-trend'],
  capabilities: {
    timeframes: ['1d', '1w', '1mo'],
    session: false,
  },
  params: [
    {
      key: 'entry',
      label: 'Signal',
      type: 'select',
      default: 'setup9',
      options: [
        { value: 'setup9', label: 'Setup 9' },
        { value: 'countdown13', label: 'Countdown 13' },
        { value: 'either', label: 'Setup 9 or Countdown 13' },
      ],
    },
    { key: 'perfectOnly', label: 'Perfected 9s only', type: 'boolean', default: false, help: 'Ignore setups where bar 8/9 did not exceed bars 6/7.' },
    { key: 'lookback', label: 'Setup lookback', type: 'number', default: 4, min: 1, max: 10, step: 1 },
    { key: 'setupLength', label: 'Setup length', type: 'number', default: 9, min: 3, max: 15, step: 1 },
    { key: 'countdownLength', label: 'Countdown length', type: 'number', default: 13, min: 5, max: 21, step: 1 },
    { key: 'cancelOnTdst', label: 'Cancel countdown beyond TDST', type: 'boolean', default: true },
    { key: 'recycle', label: 'Recycle countdown on new setup', type: 'boolean', default: false },
  ],
  run(bars, p) {
    const td = tdSequential(bars, p);
    const n = bars.length;
    const target = new Array(n).fill(null);
    const useSetup = p.entry === 'setup9' || p.entry === 'either';
    const useCd = p.entry === 'countdown13' || p.entry === 'either';
    const markers = [];
    for (let i = 0; i < n; i++) {
      const buy9 = td.buySetupDone[i] && (!p.perfectOnly || td.buyPerfect[i]);
      const sell9 = td.sellSetupDone[i] && (!p.perfectOnly || td.sellPerfect[i]);
      const buy = (useSetup && buy9) || (useCd && td.buy13[i]);
      const sell = (useSetup && sell9) || (useCd && td.sell13[i]);
      if (buy && !sell) target[i] = 1;
      else if (sell && !buy) target[i] = -1;

      if (td.buySetupDone[i]) markers.push({ index: i, position: 'below', text: '9', color: td.buyPerfect[i] ? UP : '#6ee7b7aa', kind: 'setup' });
      if (td.sellSetupDone[i]) markers.push({ index: i, position: 'above', text: '9', color: td.sellPerfect[i] ? DOWN : '#fda4afaa', kind: 'setup' });
      if (td.buy13[i]) markers.push({ index: i, position: 'below', text: '13', color: '#22d3ee', kind: 'countdown', shape: 'arrowUp' });
      if (td.sell13[i]) markers.push({ index: i, position: 'above', text: '13', color: '#f472b6', kind: 'countdown', shape: 'arrowDown' });
      if (td.buyDeferred[i]) markers.push({ index: i, position: 'below', text: '+', color: '#22d3ee88', kind: 'count' });
      if (td.sellDeferred[i]) markers.push({ index: i, position: 'above', text: '+', color: '#f472b688', kind: 'count' });
      if (td.buySetup[i] > 0 && td.buySetup[i] < (p.setupLength ?? 9)) markers.push({ index: i, position: 'below', text: String(td.buySetup[i]), color: '#6ee7b766', kind: 'count' });
      if (td.sellSetup[i] > 0 && td.sellSetup[i] < (p.setupLength ?? 9)) markers.push({ index: i, position: 'above', text: String(td.sellSetup[i]), color: '#fda4af66', kind: 'count' });
    }
    return {
      target,
      markers,
      overlays: [
        { name: 'TDST resistance', color: '#fb718599', values: td.tdstResistance, style: 'dashed' },
        { name: 'TDST support', color: '#34d39999', values: td.tdstSupport, style: 'dashed' },
      ],
      td,
    };
  },
};
