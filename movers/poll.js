// Background refresh controller for /movers/. No DOM, no timers of its own: the page calls tick()
// from one interval and recover() on focus / visibility / online events, so node --test can drive it.

import { POLL_MS, acceptRefresh, pollDelayMs } from './lib.js';

/**
 * @param {object} o
 * @param {() => Promise<{data: object}>} o.load  resolves to {data, ...meta} with a validated document, rejects on any failure
 * @param {() => object} o.getCurrent         the document currently on screen (or null)
 * @param {(doc: object, info: {changed: boolean, meta: object}) => void} o.onData  called with an accepted document
 * @param {(status: object) => void} o.onStatus  called after every attempt and when a manual action starts
 * @param {() => number} [o.now]              epoch ms, injectable for tests
 */
export function createRefresher({ load, getCurrent, onData, onStatus, now = Date.now }) {
  let inFlight = null;
  let lastAttemptAt = 0;
  let lastSuccessAt = 0;
  let lastCheckedAt = 0;
  let fails = 0;
  let lastError = null;
  let attempts = 0;

  const status = () => ({ inFlight: Boolean(inFlight), fails, lastError, lastAttemptAt, lastSuccessAt, lastCheckedAt, attempts });

  function fail(error) {
    fails += 1;
    lastError = error;
  }

  /** One fetch. A call made while another is running joins it instead of starting a second request. */
  function refresh() {
    if (inFlight) return inFlight;
    attempts += 1;
    lastAttemptAt = now();
    inFlight = (async () => {
      try {
        const result = await load();
        const doc = result.data;
        const verdict = acceptRefresh(getCurrent(), doc);
        lastCheckedAt = now();
        if (verdict.accept) {
          fails = 0;
          lastError = null;
          lastSuccessAt = lastCheckedAt;
          onData(doc, { changed: verdict.changed, meta: result });
        } else if (verdict.kind === 'older') {
          fails = 0;
          lastError = null;
        } else {
          fail(new Error(verdict.reason));
        }
      } catch (error) {
        fail(error);
      } finally {
        inFlight = null;
        onStatus(status());
      }
    })();
    return inFlight;
  }

  /** The first load happened outside the controller; start the polling clock from it. */
  function seed() {
    lastAttemptAt = now();
    lastCheckedAt = lastAttemptAt;
    lastSuccessAt = lastAttemptAt;
  }

  /** True when the next background fetch is due. */
  function due() {
    if (inFlight) return false;
    if (!lastAttemptAt) return true;
    return now() - lastAttemptAt >= pollDelayMs({ now: new Date(now()), fails });
  }

  /** Called by the page's interval. Hidden tabs do not poll. */
  function tick({ visible = true } = {}) {
    if (visible && due()) return refresh();
    return null;
  }

  /** Focus, visibility and network recovery: fetch now unless one just ran. */
  function recover({ visible = true } = {}) {
    if (!visible || inFlight) return inFlight;
    if (lastAttemptAt && now() - lastAttemptAt < POLL_MS.minGap) return null;
    return refresh();
  }

  return { refresh, tick, recover, due, seed, status };
}
