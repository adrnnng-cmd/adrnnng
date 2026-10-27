// Short copy for the assumptions strip. Methodology holds the full definitions.
// Wording matches the engine: equity fills at the next open; clock state fills
// at the clock bar's open from the last completed bar; flips fill at the next
// open; flatten exits at that bar's close; point cost is once per closed trade.

const LINE = 'Historical fills only. Signal on the close, fill at the next open. Not a live order.';

const SESSION_OFF = 'Not in force on this run.';

const SESSION_ON =
  'Hong Kong session 09:15–12:00 and 13:00–16:30. Clock fills at the clock open from the last completed bar’s direction. Any flip fills at the next open. First flip after the clock ignores earlier flips and fills at the next open. After the flip: flat stays out for the day; re-enter takes the original side again; reverse takes the new side. Flatten exits at that bar’s close.';

/**
 * @param {{ mode?: 'equity'|'hsi-daily'|'matrix', commission?: number, slippage?: number, costPoints?: number, confirm?: string, flattenEod?: boolean }} ctx
 */
export function deskAssumptions(ctx = {}) {
  const mode = ctx.mode || 'equity';
  const commission = Number.isFinite(Number(ctx.commission)) ? Number(ctx.commission) : 5;
  const slippage = Number.isFinite(Number(ctx.slippage)) ? Number(ctx.slippage) : 5;
  const costPoints = Number.isFinite(Number(ctx.costPoints)) ? Number(ctx.costPoints) : 0;

  if (mode === 'matrix') {
    let data = 'Stored ATR SuperTrend matrix, factor 2.5, EMA smoothing 2. This page does not replay the minute tape.';
    if (ctx.confirm === 'daily' || ctx.flattenEod === false) data += ' Daily agrees and flatten off are not stored.';
    return {
      line: LINE,
      cost: `Round-trip cost is ${costPoints} index points, once per closed trade. Default is 8 on a 1-minute exit and 6 on a 5-minute, 30-minute, or 1-hour exit. 0 is price only.`,
      session: SESSION_ON,
      data,
    };
  }

  if (mode === 'hsi-daily') {
    return {
      line: LINE,
      cost: 'Index points for one unit. Basis-point commission is not applied. Point cost is off.',
      session: SESSION_OFF,
      data: 'HSI futures daily bars. Weekly and monthly bars are built from the daily bars.',
    };
  }

  return {
    line: LINE,
    cost: `Commission ${commission} bps and slippage ${slippage} bps each side. 0 is off.`,
    session: SESSION_OFF,
    data: 'Daily OHLCV, split-adjusted. Weekly and monthly bars are built from the daily bars.',
  };
}
