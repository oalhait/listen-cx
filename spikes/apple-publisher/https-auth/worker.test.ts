import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker, { type ProbeEnvironment } from './worker';

const origin = 'https://listen-cx-apple-auth-spike-dev.omar-alhait.workers.dev';
const invite = 'a'.repeat(64);
const headers = { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };

describe('isolated HTTPS Apple authorization probe', () => {
  it('requires the invitation before exposing the short-lived developer token', async () => {
    expect((await SELF.fetch(`${origin}/developer-token`, { headers })).status).toBe(401);
    expect((await SELF.fetch(`${origin}/session`, { method: 'POST', headers, body: JSON.stringify({ invite: 'b'.repeat(64) }) })).status).toBe(401);
    const session = await SELF.fetch(`${origin}/session`, { method: 'POST', headers, body: JSON.stringify({ invite }) });
    expect(session.status).toBe(204);
    expect(session.headers.get('Referrer-Policy')).toBe('no-referrer');
    const cookie = session.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    const token = await SELF.fetch(`${origin}/developer-token`, { headers: { ...headers, Cookie: cookie.split(';')[0]! } });
    expect(token.status).toBe(200);
    expect(token.headers.get('Cache-Control')).toBe('no-store');
    expect(token.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(token.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await token.json<{ developerToken: string }>()).developerToken).toBe(env.DEVELOPER_TOKEN);
  });

  it('rejects other origins and all local publishing or control paths', async () => {
    for (const other of ['https://listen.cx', 'https://staging.listen.cx', 'http://127.0.0.1:8794']) {
      expect((await SELF.fetch(`${other}/`)).status).toBe(404);
      expect((await SELF.fetch(`${origin}/session`, { method: 'POST', headers: { ...headers, Origin: other }, body: JSON.stringify({ invite }) })).status).toBe(403);
    }
    for (const path of ['/state', '/reserve', '/created', '/readback', '/control/publish', '/v1/me/library/playlists', '/.local/web-recreate-journal.json']) {
      expect((await SELF.fetch(`${origin}${path}`, { method: 'POST', headers, body: '{}' })).status).toBe(404);
    }
  });

  it('serves an auth-only page without credentials or an invitation in its assets', async () => {
    const page = await SELF.fetch(`${origin}/`);
    const text = await page.text();
    expect(page.status).toBe(200);
    expect(text).toContain('Authorize Apple Music');
    expect(text).not.toContain(invite);
    expect(text).not.toContain(env.DEVELOPER_TOKEN);
    expect(text).not.toContain('Create revision');
    const source = await (await SELF.fetch(`${origin}/probe.mjs`)).text();
    expect(source).toContain('readAuthorizedStorefront');
    expect(source).not.toContain('/v1/me/library/playlists');
  });

  it('shares only the origin from authorization pages so Apple can establish its callback channel', async () => {
    for (const path of ['/', '/control']) {
      const page = await SELF.fetch(`${origin}${path}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('Referrer-Policy')).toBe('strict-origin');
      expect(page.headers.get('Cache-Control')).toContain('no-store');
    }
    for (const path of ['/probe.mjs', '/control.mjs', '/developer-token', '/missing']) {
      const response = await SELF.fetch(`${origin}${path}`, { headers });
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    }
  });

  it('permits opening the invitation from another site without permitting cross-site API access', async () => {
    expect((await SELF.fetch(`${origin}/`, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } })).status).toBe(200);
    expect((await SELF.fetch(`${origin}/developer-token`, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Cookie: `__Host-apple-auth-probe=${invite}` } })).status).toBe(403);
  });

  it('serves the direct MusicKit control through the same protected origin', async () => {
    const page = await SELF.fetch(`${origin}/control`, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Direct MusicKit control');
    expect(page.headers.get('Content-Security-Policy')).toBe((await SELF.fetch(`${origin}/`)).headers.get('Content-Security-Policy'));
    const script = await SELF.fetch(`${origin}/control.mjs`);
    expect(script.status).toBe(200);
    expect(await script.text()).not.toContain(env.DEVELOPER_TOKEN);
    expect((await SELF.fetch(`${origin}/message-diagnostic.mjs`)).status).toBe(200);
    expect((await SELF.fetch(`${origin}/credential-pairing.mjs`)).status).toBe(200);
    expect((await SELF.fetch(`${origin}/control`, { method: 'POST' })).status).toBe(404);
  });

  it('fails closed outside dev or after the developer token expires', async () => {
    const request = new Request(`${origin}/developer-token`, { headers: { ...headers, Cookie: `__Host-apple-auth-probe=${invite}` } });
    expect((await worker.fetch(request, { ...env, DEPLOYMENT_STAGE: 'prod' } as ProbeEnvironment)).status).toBe(503);
    const expired = `header.${btoa(JSON.stringify({ iat: 1, exp: 901 }))}.signature`;
    expect((await worker.fetch(request, { ...env, DEVELOPER_TOKEN: expired } as ProbeEnvironment)).status).toBe(410);
    expect((await worker.fetch(request, { ...env, DEVELOPER_TOKEN: '' } as ProbeEnvironment)).status).toBe(503);
  });
});
