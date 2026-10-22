// One thread of the precompute. Loads the tape itself so the parent does not
// clone every bar into the worker.

import { parentPort, workerData } from 'node:worker_threads';
import { loadTape } from './tape.js';
import { computeEntryGroup, prepareDayBars } from './precompute.js';

const dayBars = prepareDayBars(loadTape(workerData));

parentPort.on('message', (job) => {
  try {
    const group = computeEntryGroup(dayBars, job);
    parentPort.postMessage({ ok: true, group });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message || String(err) });
  }
});
