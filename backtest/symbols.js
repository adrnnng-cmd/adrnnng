// Symbol rules shared by the page and the futures provider.
// Every symbol on /backtest/ supports daily bars. 1-minute and 5-minute bars
// are HSI futures only.

export const HSI_FUTURES = Object.freeze({
  symbol: 'HSImain',
  name: 'HSI Futures',
  group: 'Futures',
  currency: 'pts',
  exchange: 'HKFE',
});

export const INTRADAY_TIMEFRAMES = Object.freeze(['1m', '5m']);

export const TIMEFRAME_CHOICES = Object.freeze([
  { id: '1d', label: 'Daily', intraday: false },
  { id: '1w', label: 'Weekly', intraday: false },
  { id: '1mo', label: 'Monthly', intraday: false },
  { id: '1m', label: '1m', intraday: true },
  { id: '5m', label: '5m', intraday: true },
]);

export function isHsiFutures(symbol) {
  return symbol === HSI_FUTURES.symbol;
}

export function isIntradayTimeframe(tf) {
  return INTRADAY_TIMEFRAMES.includes(tf);
}

/** 1m and 5m stay visible but disabled unless the symbol is HSI futures. */
export function timeframeChoices(symbol) {
  const allowed = isHsiFutures(symbol);
  return TIMEFRAME_CHOICES.map((tf) => ({
    ...tf,
    disabled: tf.intraday && !allowed,
    reason: tf.intraday && !allowed ? '1-minute and 5-minute bars are only available for HSI futures' : '',
  }));
}

/** Picking 1m or 5m locks the security to HSI futures. */
export function lockedSymbol(tf) {
  return isIntradayTimeframe(tf) ? HSI_FUTURES.symbol : null;
}
