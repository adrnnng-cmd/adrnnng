// Copy for the assumptions strip on /backtest/.
// The strip states the fill, the cost, and whether the Hong Kong session
// rules are in force for the run on screen. Wording matches session.js:
// clock state fills at the clock bar's open; flips fill at the next open;
// flatten exits at that bar's close; point cost is once per closed trade.

export const SESSION_RULES =
  'Hong Kong day session is 09:15–12:00 and 13:00–16:30. Clock state fills at the clock bar’s open from the last completed bar’s direction. Any flip fills at the next bar’s open. First flip after the clock ignores earlier flips and fills at the next open. After the flip: flat exits on the opposite flip and stays out for the day; re-enter takes a later flip back to the original side; reverse takes the new side on the opposite flip. Flatten exits at that bar’s close.';

const LINE =
  'Research backtest of historical fills. Not a live order. A signal is read on the close; an equity fill is the next open.';

const SESSION_OFF = `Not in force on this run. Clock, exit, after the flip, confirm, flatten, and point cost do not change this result. On HSI futures 1-minute and 5-minute ATR SuperTrend they mean: ${SESSION_RULES}`;

/**
 * @param {{ mode?: 'equity'|'hsi-daily'|'matrix', commission?: number, slippage?: number, costPoints?: number, confirm?: string, flattenEod?: boolean }} ctx
 */
export function deskAssumptions(ctx = {}) {
  const mode = ctx.mode || 'equity';
  const commission = Number.isFinite(Number(ctx.commission)) ? Number(ctx.commission) : 5;
  const slippage = Number.isFinite(Number(ctx.slippage)) ? Number(ctx.slippage) : 5;
  const costPoints = Number.isFinite(Number(ctx.costPoints)) ? Number(ctx.costPoints) : 0;

  if (mode === 'matrix') {
    let data =
      'Stored ATR SuperTrend result for HSI futures. This page reads that matrix and does not replay the minute tape. Factor 2.5 and EMA smoothing 2 are the stored study.';
    if (ctx.confirm === 'daily' || ctx.flattenEod === false) {
      data += ' Daily agrees and turning flatten off are not in the stored matrix.';
    }
    return {
      line: LINE,
      cost: `Round-trip cost is ${costPoints} index points, subtracted once on each closed trade. Default is 8 points on a 1-minute exit and 6 on a 5-minute exit. 0 is price movement only. Basis-point commission is not applied.`,
      session: `In force on this run. ${SESSION_RULES}`,
      data,
    };
  }

  if (mode === 'hsi-daily') {
    return {
      line: LINE,
      cost: 'Score is index points for one unit. Basis-point commission and slippage are not applied. Point cost is off on daily, weekly, and monthly bars.',
      session: SESSION_OFF,
      data: 'HSI futures daily bars. Weekly and monthly bars are built from the daily bars. The minute tape is not loaded.',
    };
  }

  return {
    line: LINE,
    cost: `Commission ${commission} bps and slippage ${slippage} bps on each side, entry and exit. 0 turns that leg off. Stop, take profit, and max bars at 0 are off and, when set, exit at the next open. Point cost is not used.`,
    session: SESSION_OFF,
    data: 'Daily OHLCV, split-adjusted. Weekly and monthly bars are built from the daily bars. Dividends on scales earlier prices by (1 − dividend ÷ previous close).',
  };
}
