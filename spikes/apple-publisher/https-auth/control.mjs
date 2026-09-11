import { authorizationError, tokenLifetime, readAuthorizedStorefront } from './web-authorization.mjs';
import { messageDiagnostic } from './message-diagnostic.mjs';
import { createCredentialObserver } from './credential-pairing.mjs';

const button = document.querySelector('#authorize');
const status = document.querySelector('#status');
const events = [];
let music;
let tokenTimes;
let credentialObserver;
let observing = false;
function diagnose(event) {
  events.push({ at: new Date().toISOString(), ...event });
  if (events.length > 40) events.shift();
  document.querySelector('#diagnostics').textContent = JSON.stringify({ mode: 'direct-sdk', origin: window.location.origin, secureContext: window.isSecureContext, topLevel: window.parent === window, hasOpener: window.opener !== null, serviceWindowName: window.name === 'apple-music-service-view', tokenLifetime: tokenTimes ? tokenLifetime(tokenTimes) : null, isAuthorized: music?.isAuthorized ?? false, events }, null, 2);
}
window.addEventListener('message', event => {
  if (observing) diagnose({ type: 'window-message', ...messageDiagnostic(event, window.location.origin) });
}, true);
document.addEventListener('securitypolicyviolation', event => diagnose({ type: 'blocked-by-csp', directive: ['connect-src', 'script-src', 'frame-src', 'form-action'].includes(event.effectiveDirective) ? event.effectiveDirective : 'other' }));
button.onclick = async () => {
  button.disabled = true;
  observing = true;
  try {
    if (!tokenLifetime(tokenTimes).ready) { status.textContent = 'This test session expired. A fresh test session is required.'; return; }
    diagnose({ type: 'authorization-started', userGestureActive: window.navigator.userActivation?.isActive ?? null });
    status.textContent = 'Waiting for Apple Music consent…';
    credentialObserver.begin();
    await music.authorize();
    credentialObserver.end();
    if (!music.isAuthorized) throw new Error('AUTHORIZATION_INCOMPLETE');
    diagnose({ type: 'authorization-succeeded' });
    const storefront = await readAuthorizedStorefront(music);
    diagnose({ type: 'storefront-readback', succeeded: true, storefront });
    status.textContent = 'Direct MusicKit authorization and read-only storefront readback succeeded.';
  } catch (error) {
    diagnose({ type: 'operation-error', ...authorizationError(error) });
    status.textContent = 'Direct MusicKit authorization or readback failed. Preserve the Safe diagnostics below.';
  } finally { credentialObserver?.end(); button.disabled = false; }
};

async function initialize() {
  const invite = new URLSearchParams(window.location.hash.slice(1)).get('invite');
  window.history.replaceState(null, '', '/');
  if (invite) {
    const session = await fetch('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite }) });
    if (!session.ok) throw new Error('INVITATION_UNAVAILABLE');
  }
  const response = await fetch('/developer-token');
  if (!response.ok) { status.textContent = response.status === 410 ? 'This short-lived test session expired.' : 'Open the protected control invitation to use this test.'; return; }
  const { developerToken, issuedAt, expiresAt } = await response.json();
  tokenTimes = { issuedAt, expiresAt };
  credentialObserver = createCredentialObserver(window, developerToken, diagnose);
  window.addEventListener('pagehide', () => credentialObserver.dispose(), { once: true });
  document.addEventListener('musickitloaded', async () => {
    try {
      await window.MusicKit.configure({ developerToken, app: { name: 'listen.cx disposable web spike', build: '1' } });
      music = window.MusicKit.getInstance();
      music.addEventListener('authorizationStatusDidChange', event => diagnose({ type: 'authorization-status', status: Number.isInteger(event.authorizationStatus) ? event.authorizationStatus : null }));
      diagnose({ type: 'musickit-ready' });
      button.disabled = false;
      status.textContent = 'Ready for the direct MusicKit control.';
    } catch (error) { diagnose({ type: 'initialization-error', ...authorizationError(error) }); status.textContent = 'MusicKit initialization failed.'; }
  });
  const script = document.createElement('script');
  script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
  document.head.append(script);
}
try { await initialize(); } catch { status.textContent = 'The protected control could not initialize. No authorization was attempted.'; }
