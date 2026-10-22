// Auth hook for /api/hsi-lab only. The lab is public; authorize() allows
// the request. Replace the body of authorize() to require a login later.

import { applyAuth } from '../../../hsi-lab/server/auth.js';

export function onRequest(context) {
  return applyAuth(context);
}
