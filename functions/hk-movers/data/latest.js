// Old path of the Movers snapshot, kept so the existing live feed and any page that is still cached
// keep working after the page moved to /movers/. It serves exactly what /movers/data/latest serves
// (same KV key, same demo fallback); there is no second copy of the logic.
//   GET /hk-movers/data/latest

import { serveLatest } from '../../movers/data/latest.js';

export function onRequest(context) {
  return serveLatest({ method: context.request.method, env: context.env, requestUrl: context.request.url });
}
