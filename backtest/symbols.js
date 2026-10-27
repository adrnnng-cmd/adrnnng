// Symbol rules shared by the page and the futures provider.
// Every symbol on /backtest/ supports daily bars. 1m, 5m, 30m, and 1h
// are HSI futures only. There is no 15-minute choice.

export const HSI_FUTURES = Object.freeze({
  symbol: 'HSImain',
  name: 'HSI Futures',
  group: 'Futures',
  currency: 'pts',
  exchange: 'HKFE',
});

/** Clock-aligned bar size in minutes. 1h is 60. 15m is not a choice. */
export const INTRADAY_MINUTES = Object.freeze({
  '1m': 1,
  '5m': 5,
  '30m': 30,
  '1h': 60,
});

export const INTRADAY_TIMEFRAMES = Object.freeze(Object.keys(INTRADAY_MINUTES));

export const TIMEFRAME_CHOICES = Object.freeze([
  { id: '1d', label: 'Daily', intraday: false },
  { id: '1w', label: 'Weekly', intraday: false },
  { id: '1mo', label: 'Monthly', intraday: false },
  { id: '1m', label: '1m', intraday: true },
  { id: '5m', label: '5m', intraday: true },
  { id: '30m', label: '30m', intraday: true },
  { id: '1h', label: '1h', intraday: true },
]);

export function isHsiFutures(symbol) {
  return symbol === HSI_FUTURES.symbol;
}

export function isIntradayTimeframe(tf) {
  return INTRADAY_TIMEFRAMES.includes(tf);
}

/** 1m, 5m, 30m, and 1h stay visible but disabled unless the symbol is HSI futures. */
export function timeframeChoices(symbol) {
  const allowed = isHsiFutures(symbol);
  return TIMEFRAME_CHOICES.map((tf) => ({
    ...tf,
    disabled: tf.intraday && !allowed,
    reason: tf.intraday && !allowed ? '1m, 5m, 30m, and 1h are only available for HSI futures' : '',
  }));
}

/** Picking 1m, 5m, 30m, or 1h locks the security to HSI futures. */
export function lockedSymbol(tf) {
  return isIntradayTimeframe(tf) ? HSI_FUTURES.symbol : null;
}
