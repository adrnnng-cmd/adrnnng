// Which composition controls change the run that is on screen.
// The row itself is always shown. A control that the current strategy and
// period do not read is disabled, with a short reason, instead of being left
// live and ignored.
//
// Clock, exit, confirm, flatten, and point cost are read by the stored HSI
// futures 1-minute and 5-minute ATR SuperTrend matrix (and by a strategy that
// declares `capabilities.session` on those bars). Daily, weekly, and monthly
// runs do not read them. By year / custom dates set From and To for every
// strategy. Entry ATR is shown only when the strategy has an `atrLength` param.

import { isHsiFutures, isIntradayTimeframe } from '../symbols.js';

const MATRIX = 'Applies to HSI futures 1-minute and 5-minute ATR SuperTrend.';

function on(reason = '') {
  return { enabled: true, hidden: false, reason };
}

function off(reason) {
  return { enabled: false, hidden: false, reason };
}

function hide(reason) {
  return { enabled: false, hidden: true, reason };
}

export function strategyTimeframes(strategy) {
  const listed = strategy?.capabilities?.timeframes;
  if (Array.isArray(listed) && listed.length) return listed.slice();
  return ['1d', '1w', '1mo'];
}

/** A timeframe the strategy does not list falls back to daily. */
export function supportedTimeframe(strategy, tf) {
  const allowed = strategyTimeframes(strategy);
  if (allowed.includes(tf)) return tf;
  return allowed.includes('1d') ? '1d' : allowed[0];
}

export function hasSession(strategy) {
  return Boolean(strategy?.capabilities?.session);
}

/**
 * Period button policy on top of the symbol lock.
 * `block` means a click must do nothing. A disabled 1m/5m button that is not
 * blocked still selects that period and locks the security to HSI futures.
 */
export function periodAvailability(strategy, symbol, timeframeId) {
  const intraday = isIntradayTimeframe(timeframeId);
  if (!strategyTimeframes(strategy).includes(timeframeId)) {
    return {
      disabled: true,
      block: true,
      reason: intraday
        ? '1-minute and 5-minute bars are the stored ATR SuperTrend result for HSI futures.'
        : 'This strategy does not run on that period.',
    };
  }
  if (intraday && !isHsiFutures(symbol)) {
    return {
      disabled: true,
      block: false,
      reason: '1-minute and 5-minute bars are only available for HSI futures',
    };
  }
  return { disabled: false, block: false, reason: '' };
}

/**
 * @param {object} strategy registry entry
 * @param {{ symbol?: string, timeframe?: string, exitTimeframe?: string, entryRule?: string }} ctx
 */
export function compositionSlots(strategy, ctx = {}) {
  const symbol = ctx.symbol || '';
  const timeframe = ctx.timeframe || '1d';
  const exitTimeframe = ctx.exitTimeframe || timeframe;
  const entryRule = ctx.entryRule || 'flip';
  const session = hasSession(strategy);
  // The stored minute matrix is ATR SuperTrend only. Another study can set
  // capabilities.session later without inheriting that lookup.
  const matrix = strategy?.id === 'atr-supertrend' && session && isHsiFutures(symbol) && isIntradayTimeframe(timeframe);
  const hasAtr = Boolean(strategy?.params?.some((p) => p.key === 'atrLength'));
  const splitExit = matrix && exitTimeframe !== timeframe;

  let hint;
  if (matrix) {
    hint = 'Day session 09:15–16:30 Hong Kong time. A flip fills at the next bar’s open. Daily confirm is not in the stored results. By year sets From and To.';
  } else if (session) {
    hint = 'Entry ATR is this study’s length. Clock, exit, confirm, and point cost turn on for HSI futures 1-minute and 5-minute bars. By year sets From and To.';
  } else {
    hint = 'Clock, exit, confirm, and point cost are for HSI futures 1-minute and 5-minute ATR SuperTrend. This strategy runs on the period above. By year sets From and To.';
  }

  return {
    visible: true,
    matrix,
    hint,
    recipe: on('Applies an ATR SuperTrend recipe on HSI futures.'),
    entry: matrix ? on('') : off(MATRIX),
    exitTf: matrix ? on('') : off(MATRIX),
    clock: !matrix ? off(MATRIX) : entryRule === 'flip' ? off('Clock is not used for Any flip.') : on(''),
    exitRule: matrix ? on('') : off(MATRIX),
    confirm: matrix ? on('Daily agrees is not in the stored results.') : off('Daily bars are already the signal. A separate daily confirm is only a slot on HSI futures 1-minute and 5-minute bars.'),
    session: on(''),
    entryAtr: hasAtr ? on('') : hide('This strategy has no ATR length.'),
    exitAtr: !hasAtr
      ? hide('This strategy has no ATR length.')
      : splitExit
        ? on('')
        : off(matrix ? 'Exit ATR matches Entry ATR while the timeframes match.' : 'Exit ATR applies when the HSI futures exit timeframe differs from the entry.'),
    flatten: matrix
      ? on('Stored results flatten at the Hong Kong session close. Turning this off is not computed yet.')
      : off('Flatten at the session close applies to HSI futures 1-minute and 5-minute bars.'),
    cost: matrix
      ? on('')
      : off(isHsiFutures(symbol)
        ? 'Point cost applies to the stored 1-minute and 5-minute HSI futures score.'
        : 'Point cost applies to the stored HSI futures score. Daily runs use commission in Settings.'),
  };
}
