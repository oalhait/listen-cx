import { authorizationError, appleCallback, authorizeSubscriber, tokenLifetime, readAuthorizedStorefront } from './web-authorization.mjs';

const button = document.querySelector('#authorize');
const status = document.querySelector('#status');
const events = [];
let music;
let tokenTimes;
function diagnose(event) {
  events.push({ at: new Date().toISOString(), ...event });
  document.querySelector('#diagnostics').textContent = JSON.stringify({ origin: location.origin, secureContext: window.isSecureContext, tokenLifetime: tokenTimes ? tokenLifetime(tokenTimes) : null, isAuthorized: music?.isAuthorized ?? false, events: events.slice(-24) }, null, 2);
}
window.addEventListener('message', event => {
  const callback = appleCallback(event);
  if (callback) diagnose({ type: 'apple-callback', ...callback });
});
document.addEventListener('securitypolicyviolation', event => diagnose({ type: 'blocked-by-csp', directive: ['connect-src', 'script-src', 'frame-src', 'form-action'].includes(event.effectiveDirective) ? event.effectiveDirective : 'other' }));
button.onclick = async () => {
  button.disabled = true;
  try {
    if (!tokenLifetime(tokenTimes).ready) { status.textContent = 'This test session expired. A fresh test session is required.'; return; }
    diagnose({ type: 'authorization-started', userGestureActive: navigator.userActivation?.isActive ?? null });
    await authorizeSubscriber(music, window, diagnose);
    diagnose({ type: 'authorization-succeeded' });
    const storefront = await readAuthorizedStorefront(music);
    diagnose({ type: 'storefront-readback', succeeded: true, storefront });
    status.textContent = 'Apple Music authorization succeeded. The read-only storefront request completed. No playlist was created.';
  } catch (error) {
    diagnose({ type: 'operation-error', ...authorizationError(error) });
    status.textContent = 'Authorization or readback failed. The diagnostics show the observed result; no playlist was created.';
  } finally { button.disabled = false; }
};

async function initialize() {
  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  history.replaceState(null, '', '/');
  if (invite) {
    const session = await fetch('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite }) });
    if (!session.ok) throw new Error('INVITATION_UNAVAILABLE');
  }
  const response = await fetch('/developer-token');
  if (!response.ok) {
    status.textContent = response.status === 410 ? 'This short-lived test session expired.' : 'Open the protected invitation to use this test.';
    return;
  }
  const { developerToken, issuedAt, expiresAt } = await response.json();
  tokenTimes = { issuedAt, expiresAt };
  document.addEventListener('musickitloaded', async () => {
    try {
      await MusicKit.configure({ developerToken, app: { name: 'listen.cx disposable web spike', build: '1' } });
      music = MusicKit.getInstance();
      music.addEventListener('authorizationStatusDidChange', event => diagnose({ type: 'authorization-status', status: Number.isInteger(event.authorizationStatus) ? event.authorizationStatus : null }));
      diagnose({ type: 'musickit-ready' });
      button.disabled = false;
      status.textContent = 'Ready to test Apple Music consent on HTTPS.';
    } catch (error) { diagnose({ type: 'initialization-error', ...authorizationError(error) }); status.textContent = 'MusicKit initialization failed.'; }
  });
  const script = document.createElement('script');
  script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
  document.head.append(script);
}
void initialize().catch(() => { status.textContent = 'The protected test could not initialize. No authorization was attempted.'; });
