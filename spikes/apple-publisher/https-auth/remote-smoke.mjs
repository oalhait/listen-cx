import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { get } from 'node:https';

const origin = 'https://listen-cx-apple-auth-spike-dev.omar-alhait.workers.dev';
const invitation = await readFile(new URL('../.local/https-invitation.html', import.meta.url), 'utf8');
const invite = invitation.match(/#invite=([a-f0-9]{64})/)?.[1];
assert.ok(invite, 'Private test invitation is missing');
const headers = { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };
const landing = await new Promise((resolve, reject) => {
  get(origin, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } }, response => {
    response.resume();
    resolve(response.statusCode);
  }).on('error', reject);
});
const publicToken = await fetch(`${origin}/developer-token`, { headers });
const foreignSession = await fetch(`${origin}/session`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify({ invite }) });
const localControl = await fetch(`${origin}/reserve`, { method: 'POST', headers, body: '{}' });
const session = await fetch(`${origin}/session`, { method: 'POST', headers, body: JSON.stringify({ invite }) });
const cookie = session.headers.get('set-cookie')?.split(';')[0];
assert.equal(session.status, 204, 'Protected test session failed');
assert.ok(cookie, 'Protected test cookie is missing');
const token = await fetch(`${origin}/developer-token`, { headers: { ...headers, Cookie: cookie } });
const result = { at: new Date().toISOString(), landing, publicToken: publicToken.status, foreignSession: foreignSession.status, localControl: localControl.status, protectedSession: session.status, protectedToken: token.status, tokenCache: token.headers.get('Cache-Control') };
assert.equal(result.landing, 200);
assert.equal(result.publicToken, 401);
assert.equal(result.foreignSession, 403);
assert.equal(result.localControl, 404);
assert.equal(result.protectedToken, 200);
assert.equal(result.tokenCache, 'no-store');
await writeFile(new URL('../.local/https-smoke.json', import.meta.url), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result));
