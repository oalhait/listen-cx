import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createRevisionServer(file) {
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    if (request.url !== '/desired') {
      response.writeHead(404).end('{"error":"not_found"}');
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      response.writeHead(405).end('{"error":"read_only"}');
      return;
    }
    try {
      const desired = JSON.parse(await readFile(file, 'utf8'));
      if (typeof desired.playlistKey !== 'string' || !desired.playlistKey.length || Buffer.byteLength(desired.playlistKey) > 128 ||
          !Number.isSafeInteger(desired.revision) || desired.revision < 1 ||
          !Array.isArray(desired.trackIDs) || desired.trackIDs.length > 100 ||
          !desired.trackIDs.every(id => typeof id === 'string' && id.length && Buffer.byteLength(id) <= 128)) {
        throw new Error('Invalid fixture');
      }
      response.writeHead(200).end(JSON.stringify({ playlistKey: desired.playlistKey, revision: desired.revision, trackIDs: desired.trackIDs }));
    } catch {
      response.writeHead(503).end('{"error":"desired_unavailable"}');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node server.mjs <desired.json> [bind-address]');
  const host = process.argv[3] ?? '127.0.0.1';
  createRevisionServer(file).listen(8790, host, () => {
    console.log(`Read-only developer fixture: http://${host}:8790/desired`);
  });
}
