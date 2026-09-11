import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDeveloperToken } from './token-helper.mjs';
import { reserveRevision, recordCreation } from './web-recreate.mjs';
import { authorizationDiagnostic } from './web-authorization.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const assets = { '/': ['web-recreate.html', 'text/html'], '/web-recreate-browser.mjs': ['web-recreate-browser.mjs', 'text/javascript'], '/web-recreate.mjs': ['web-recreate.mjs', 'text/javascript'], '/web-authorization.mjs': ['web-authorization.mjs', 'text/javascript'] };

export function createWebServer({ journalFile, developerToken, fixtures }) {
  mkdirSync(dirname(journalFile), { recursive: true, mode: 0o700 });
  let state = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : { runID: randomUUID().slice(0, 8), revisions: [] };
  const authorizationDiagnostics = [];
  const save = next => {
    writeFileSync(`${journalFile}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(`${journalFile}.tmp`, journalFile);
    state = next;
  };
  const server = createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    const origin = `http://${host}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://js-cdn.music.apple.com; connect-src 'self' https://*.apple.com https://*.mzstatic.com; img-src 'self' data: https://*.mzstatic.com; style-src 'self' 'unsafe-inline'; frame-src https://*.apple.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site']))) {
      res.writeHead(403).end('{}');
      return;
    }
    try {
      if (req.method === 'GET') {
        if (assets[req.url]) {
          const [file, type] = assets[req.url];
          res.setHeader('Content-Type', type);
          res.end(readFileSync(resolve(directory, file)));
        } else if (req.url === '/state') res.end(JSON.stringify({ ...state, fixtures }));
        else if (req.url === '/authorization-diagnostics') res.end(JSON.stringify(authorizationDiagnostics));
        else if (req.url === '/developer-token' && req.headers['sec-fetch-site'] === 'same-origin') res.end(JSON.stringify({ developerToken: developerToken() }));
        else res.writeHead(404).end('{}');
        return;
      }
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') {
        res.writeHead(403).end('{}');
        return;
      }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 16000) throw new Error('Body too large');
      }
      const input = JSON.parse(body);
      if (req.url === '/authorization-diagnostics') {
        authorizationDiagnostics.push({ at: new Date().toISOString(), ...authorizationDiagnostic(input) });
        if (authorizationDiagnostics.length > 40) authorizationDiagnostics.shift();
        res.end('{}');
        return;
      }
      if (req.url === '/reserve') save(reserveRevision(state, input.revision));
      else if (req.url === '/created') save(recordCreation(state, input.revision, input.id));
      else if (req.url === '/readback') {
        if (!state.revisions.some(item => item.id === input.id)) throw new Error('Unknown playlist');
        const allowed = ['id', 'isPublic', 'hasCatalog', 'url', 'catalogIDs', 'trackIDs', 'libraryTrackIDs', 'matches', 'observedAt'];
        save({ ...state, readbacks: [...(state.readbacks ?? []).slice(-19), Object.fromEntries(allowed.map(key => [key, input[key]]))] });
      } else {
        res.writeHead(404).end('{}');
        return;
      }
      res.end(JSON.stringify(state));
    } catch {
      res.writeHead(409).end('{"error":"Operation refused; inspect state before continuing"}');
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { APPLE_MUSIC_KEY_ID: keyID, APPLE_MUSIC_TEAM_ID: teamID, APPLE_MUSIC_PRIVATE_KEY_P8: pem } = process.env;
  if (!keyID || !teamID || !pem) throw new Error('Apple developer signing environment is missing');
  const privateKey = pem.replace(/\\n/g, '\n');
  delete process.env.APPLE_MUSIC_PRIVATE_KEY_P8;
  const fixtureDir = resolve(directory, '.local/live-experiment');
  const fixtures = [1, 2].map(revision => JSON.parse(readFileSync(resolve(fixtureDir, `revision-${revision}.json`), 'utf8')).trackIDs);
  if (fixtures.some(ids => ids.length !== 3 || ids.some(id => !/^\d+$/.test(id)))) throw new Error('Invalid catalog fixtures');
  createWebServer({ journalFile: resolve(directory, '.local/web-recreate-journal.json'), fixtures, developerToken: () => createDeveloperToken({ keyID, teamID, privateKey }) }).listen(8794, '127.0.0.1', () => console.log('Apple browser spike: http://127.0.0.1:8794'));
}
