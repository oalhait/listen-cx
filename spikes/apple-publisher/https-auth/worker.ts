export interface ProbeEnvironment {
  DEPLOYMENT_STAGE: string;
  PUBLIC_ORIGIN: string;
  DEVELOPER_TOKEN: string;
  INVITE_DIGEST: string;
  ASSETS: Fetcher;
}

const probeOrigin = 'https://listen-cx-apple-auth-spike-dev.omar-alhait.workers.dev';
const authorizationPaths = new Set(['/', '/control', '/same-id']);
const assetPaths = new Set([...authorizationPaths, '/probe.mjs', '/web-authorization.mjs', '/control.mjs', '/message-diagnostic.mjs', '/credential-pairing.mjs', '/same-id-control.mjs', '/same-id.mjs']);
const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://js-cdn.music.apple.com; connect-src 'self' https://*.apple.com https://*.mzstatic.com; img-src 'self' data: https://*.mzstatic.com; style-src 'self' 'unsafe-inline'; frame-src https://*.apple.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

async function validInvite(invite: string, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(invite)) return false;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(invite));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') === digest;
}

export default {
  async fetch(request: Request, env: ProbeEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (env.DEPLOYMENT_STAGE !== 'dev' || env.PUBLIC_ORIGIN !== probeOrigin) return json({ error: 'dev_probe_not_configured' }, 503);
    if (url.origin !== probeOrigin) return json({ error: 'wrong_origin' }, 404);
    const requestOrigin = request.headers.get('Origin');
    const fetchSite = request.headers.get('Sec-Fetch-Site');
    const authorizationPage = authorizationPaths.has(url.pathname);
    const landingNavigation = request.method === 'GET' && authorizationPage && request.headers.get('Sec-Fetch-Mode') === 'navigate' && request.headers.get('Sec-Fetch-Dest') === 'document';
    if (!landingNavigation && ((requestOrigin && requestOrigin !== probeOrigin) || (fetchSite && !['none', 'same-origin'].includes(fetchSite)))) return json({ error: 'wrong_origin' }, 403);
    if (request.method === 'GET' && assetPaths.has(url.pathname)) {
      const asset = await env.ASSETS.fetch(request);
      return new Response(asset.body, { status: asset.status, headers: { ...Object.fromEntries(asset.headers), ...headers, 'Referrer-Policy': authorizationPage ? 'strict-origin' : headers['Referrer-Policy'] } });
    }
    if (!['/session', '/developer-token'].includes(url.pathname)) return json({ error: 'not_found' }, 404);
    if (!env.DEVELOPER_TOKEN || !/^[a-f0-9]{64}$/.test(env.INVITE_DIGEST)) return json({ error: 'dev_probe_not_configured' }, 503);
    let issuedAt: number;
    let expiresAt: number;
    try {
      const claims = JSON.parse(atob(env.DEVELOPER_TOKEN.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
      issuedAt = claims.iat;
      expiresAt = claims.exp;
      if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt - issuedAt !== 900) throw new Error();
    } catch { return json({ error: 'dev_probe_not_configured' }, 503); }
    const now = Math.floor(Date.now() / 1000);
    if (now < issuedAt || now >= expiresAt - 60) return json({ error: 'probe_expired' }, 410);
    if (url.pathname === '/session') {
      if (request.method !== 'POST' || requestOrigin !== probeOrigin || request.headers.get('Content-Type') !== 'application/json') return json({ error: 'invalid_session_request' }, 403);
      let invite: unknown;
      try {
        const body = await request.text();
        if (body.length > 256) return json({ error: 'invalid_invite' }, 400);
        invite = JSON.parse(body).invite;
      } catch { return json({ error: 'invalid_invite' }, 400); }
      if (typeof invite !== 'string' || !await validInvite(invite, env.INVITE_DIGEST)) return json({ error: 'invalid_invite' }, 401);
      return new Response(null, { status: 204, headers: { ...headers, 'Set-Cookie': `__Host-apple-auth-probe=${invite}; Path=/; Max-Age=${expiresAt - now}; HttpOnly; Secure; SameSite=Strict` } });
    }
    if (request.method !== 'GET' || fetchSite !== 'same-origin') return json({ error: 'same_origin_browser_required' }, 403);
    const cookie = request.headers.get('Cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('__Host-apple-auth-probe='))?.slice('__Host-apple-auth-probe='.length) ?? '';
    if (!await validInvite(cookie, env.INVITE_DIGEST)) return json({ error: 'invitation_required' }, 401);
    return json({ developerToken: env.DEVELOPER_TOKEN, issuedAt, expiresAt });
  },
};
