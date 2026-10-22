// Single sign-in hook for the lab API.
//
// The page is public. authorize() allows every request. A later login
// belongs in this function only: read a cookie or token from the context
// and return a Response to block, or null to allow. Do not scatter checks
// through the simulator or the page.

export async function authorize(_context) {
  return null;
}

/** Run the hook. A Response from `decide` stops the request. */
export async function applyAuth(context, decide = authorize) {
  const denied = await decide(context);
  if (denied instanceof Response) return denied;
  return context.next();
}
