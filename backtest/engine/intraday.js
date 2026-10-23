// Intraday session filter and clock-aligned resampling.
// Bar time is the wall-clock bar open, "YYYY-MM-DDTHH:mm:ss", already in the
// session timezone (Asia/Hong_Kong for HSI futures). No DST conversion here.
// A daily bar ("YYYY-MM-DD") has no clock and is left unchanged by the session filter.

/** HKFE HSI day session. Auction and the night session sit outside these windows. */
export const HSI_DAY_SESSION = Object.freeze({
  timezone: 'Asia/Hong_Kong',
  // Morning continuous trading starts at 09:15. Morning session ends at 12:00
  // (last 1-minute open is 11:59).
  morningOpenMin: 9 * 60 + 15,
  morningCloseMin: 12 * 60,
  // Afternoon continuous trading starts at 13:00.
  afternoonOpenMin: 13 * 60,
  // Day session ends at 16:30 (last 1-minute open is 16:29).
  dayCloseMin: 16 * 60 + 30,
});

export function barDate(time) {
  const m = String(time).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/** Minutes from midnight, or null when the stamp has no clock time. */
export function barMinutes(time) {
  const m = String(time).match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function inDaySession(time, session = HSI_DAY_SESSION) {
  const mins = barMinutes(time);
  if (mins == null) return false;
  const morning = mins >= session.morningOpenMin && mins < session.morningCloseMin;
  const afternoon = mins >= session.afternoonOpenMin && mins < session.dayCloseMin;
  return morning || afternoon;
}

/** Day-session bars only, original order. Daily bars (no clock) are kept. */
export function filterDaySession(bars, session = HSI_DAY_SESSION) {
  return bars.filter((b) => barMinutes(b.time) == null || inDaySession(b.time, session));
}

function stamp(date, minutes) {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${date}T${hh}:${mm}:00`;
}

/**
 * Aggregate intraday bars into one bar per calendar date, stamped YYYY-MM-DD.
 * Bars that are already daily pass through.
 */
export function toDaily(bars) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const date = barDate(b.time);
    if (!date) continue;
    if (!cur || cur.time !== date) {
      if (cur) out.push(cur);
      cur = { time: date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0, dividend: 0, split: 0 };
    } else {
      if (b.high > cur.high) cur.high = b.high;
      if (b.low < cur.low) cur.low = b.low;
      cur.close = b.close;
      cur.volume += b.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Aggregate bars into `minutes`-sized buckets aligned to the clock
 * (bucket open is a multiple of `minutes` past midnight). 09:15 is on a
 * 5-minute boundary, so HSI 5-minute bars open at 09:15, 09:20, …, 11:55, 13:00.
 * Session-filter first so a bucket cannot mix the lunch break.
 * A bucket with at least one bar is emitted even if it is short.
 */
export function resampleMinutes(bars, minutes) {
  if (minutes === 1) return bars.map((b) => ({ ...b }));
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error(`Bad bar size ${minutes}`);
  const out = [];
  let cur = null;
  let curKey = null;
  for (const b of bars) {
    const mins = barMinutes(b.time);
    const date = barDate(b.time);
    if (mins == null || !date) throw new Error(`Cannot resample bar time ${b.time}`);
    const bucket = Math.floor(mins / minutes) * minutes;
    const key = `${date}#${bucket}`;
    if (key !== curKey) {
      if (cur) out.push(cur);
      curKey = key;
      cur = {
        time: stamp(date, bucket),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume || 0,
      };
    } else {
      if (b.high > cur.high) cur.high = b.high;
      if (b.low < cur.low) cur.low = b.low;
      cur.close = b.close;
      cur.volume += b.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}
