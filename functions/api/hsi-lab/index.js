import { handle } from '../../../hsi-lab/server/handle.js';
import { limiter } from '../../../hsi-lab/server/rate-limit.js';

export function onRequest(context) {
  return handle(context.request, context.env, { limiter });
}
