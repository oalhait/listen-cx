import { createServer } from 'node:http';
import { sign } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createDeveloperToken({ keyID, teamID, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyID })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: teamID, iat: now, exp: now + 900 })).toString('base64url');
  const body = `${header}.${payload}`;
  return `${body}.${sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

export function createTokenServer({ token, expiresAt, now = () => Math.floor(Date.now() / 1000) }) {
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.origin || request.headers['sec-fetch-site'] || !/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? '')) {
      response.writeHead(403).end('{"error":"native_loopback_only"}');
    } else if (request.url !== '/developer-token') {
      response.writeHead(404).end('{"error":"not_found"}');
    } else if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      response.writeHead(405).end('{"error":"read_only"}');
    } else if (now() >= expiresAt) {
      response.writeHead(503).end('{"error":"token_expired"}');
    } else {
      response.writeHead(200).end(JSON.stringify({ developerToken: token, expiresAt }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { APPLE_MUSIC_KEY_ID: keyID, APPLE_MUSIC_TEAM_ID: teamID, APPLE_MUSIC_PRIVATE_KEY_P8: pem } = process.env;
  if (!keyID || !teamID || !pem) throw new Error('Required Apple developer signing environment is missing');
  const now = Math.floor(Date.now() / 1000);
  const token = createDeveloperToken({ keyID, teamID, privateKey: pem.replace(/\\n/g, '\n'), now });
  delete process.env.APPLE_MUSIC_PRIVATE_KEY_P8;
  createTokenServer({ token, expiresAt: now + 900 }).listen(8791, '127.0.0.1', () => {
    console.log(`Loopback developer token available until ${new Date((now + 900) * 1000).toISOString()}`);
  });
}
