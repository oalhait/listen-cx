const reasons = new Set(['AUTHORIZATION_ERROR', 'AUTHORIZATION_INCOMPLETE', 'ACCESS_DENIED', 'CONFIGURATION_ERROR', 'NETWORK_ERROR', 'POPUP_BLOCKED', 'REQUEST_ERROR', 'SERVER_ERROR', 'SERVICE_UNAVAILABLE', 'STOREFRONT_READBACK_FAILED', 'SUBSCRIPTION_ERROR', 'TOKEN_EXPIRED', 'USER_INTERACTION_REQUIRED']);
const callbackMethods = new Set(['authorize', 'decline', 'unavailable', 'switchUserId', 'close', 'thirdPartyInfo']);

export function authorizationError(error) {
  if (error === 'Storefront Country Code error.') return { reason: 'STOREFRONT_READBACK_FAILED', httpStatus: null };
  const reason = [error?.reason, error?.errorCode, error?.message].find(value => reasons.has(value)) ?? 'UNKNOWN_ERROR';
  const status = error?.data?.status ?? error?.status;
  return { reason, httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null };
}

export function appleCallback(event) {
  if (event.origin !== 'https://authorize.music.apple.com' || event.data?.jsonrpc !== '2.0' || !callbackMethods.has(event.data?.method)) return null;
  return { method: event.data.method };
}

export function popupRelationship(popup, host) {
  let popupClosed = null;
  let openerMatches = null;
  try { if (typeof popup.closed === 'boolean') popupClosed = popup.closed; } catch {}
  try { openerMatches = popup.opener === host; } catch {}
  return { popupClosed, openerMatches };
}

export async function authorizeSubscriber(music, popupHost, report = () => {}) {
  const originalOpen = popupHost?.open;
  let popupBlocked = false;
  let openedPopup;
  if (originalOpen) popupHost.open = function (...args) {
    const popup = originalOpen.apply(popupHost, args);
    popupBlocked = !popup;
    openedPopup = popup;
    report(popupBlocked ? { type: 'popup-blocked' } : { type: 'popup-opened', ...popupRelationship(popup, popupHost) });
    return popup;
  };
  let pending;
  try { pending = music.authorize(); }
  finally { if (originalOpen) popupHost.open = originalOpen; }
  if (popupBlocked) {
    void Promise.resolve(pending).catch(() => {});
    throw new Error('POPUP_BLOCKED');
  }
  try { await pending; }
  finally { if (openedPopup) report({ type: 'popup-settled', ...popupRelationship(openedPopup, popupHost) }); }
  if (!music.isAuthorized) throw new Error('AUTHORIZATION_INCOMPLETE');
}

export function tokenLifetime({ issuedAt, expiresAt }, now = Math.floor(Date.now() / 1000)) {
  const valid = Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt);
  return { ageSeconds: valid ? now - issuedAt : null, remainingSeconds: valid ? expiresAt - now : null, ready: valid && now >= issuedAt && now < expiresAt - 60 };
}

export async function readAuthorizedStorefront(music) {
  const result = await music.api.music('/v1/me/storefront');
  const storefront = result.data?.data?.[0]?.id;
  if (typeof storefront !== 'string' || !/^[a-z]{2}$/.test(storefront)) throw new Error('STOREFRONT_READBACK_FAILED');
  return storefront;
}

export function authorizationDiagnostic(input) {
  const types = new Set(['musickit-ready', 'authorization-started', 'authorization-succeeded', 'operation-error', 'developer-token-expired', 'apple-callback', 'authorization-status', 'blocked-by-csp', 'popup-blocked', 'popup-opened', 'popup-settled']);
  const output = { type: types.has(input.type) ? input.type : 'unknown' };
  if (reasons.has(input.reason) || input.reason === 'UNKNOWN_ERROR') output.reason = input.reason;
  if (callbackMethods.has(input.method)) output.method = input.method;
  if (['connect-src', 'script-src', 'frame-src', 'form-action', 'other'].includes(input.directive)) output.directive = input.directive;
  for (const key of ['isAuthorized', 'userGestureActive', 'popupClosed', 'openerMatches']) if (typeof input[key] === 'boolean') output[key] = input[key];
  for (const [key, min, max] of [['httpStatus', 100, 599], ['status', -1, 10], ['ageSeconds', -60, 86400], ['remainingSeconds', -86400, 900]]) {
    if (Number.isInteger(input[key]) && input[key] >= min && input[key] <= max) output[key] = input[key];
  }
  return output;
}
