import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDeveloperToken } from '../token-helper.mjs';

const { APPLE_MUSIC_KEY_ID: keyID, APPLE_MUSIC_TEAM_ID: teamID, APPLE_MUSIC_PRIVATE_KEY_P8: pem } = process.env;
if (!keyID || !teamID || !pem) throw new Error('Apple developer signing environment is missing');
const now = Math.floor(Date.now() / 1000);
const developerToken = createDeveloperToken({ keyID, teamID, privateKey: pem.replace(/\\n/g, '\n'), now });
const invite = randomBytes(32).toString('hex');
const directory = new URL('../.local/', import.meta.url);
const origin = 'https://listen-cx-apple-auth-spike-dev.omar-alhait.workers.dev';
const entryPath = process.argv.includes('--direct') ? '/control' : '/';
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(new URL('https-secrets.json', directory), JSON.stringify({ DEVELOPER_TOKEN: developerToken, INVITE_DIGEST: createHash('sha256').update(invite).digest('hex') }), { mode: 0o600 });
await writeFile(new URL('https-invitation.html', directory), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Protected Apple Music test invitation</title></head><body><h1>Protected Apple Music test</h1><p>This invitation expires at ${new Date((now + 840) * 1000).toISOString()}.</p><a href="${origin}${entryPath}#invite=${invite}">Open the HTTPS authorization test</a><p>The test only authorizes Apple Music and reads your storefront. It does not publish playlists.</p></body></html>`, { mode: 0o600 });
console.log(`Prepared private HTTPS test session; valid until ${new Date((now + 840) * 1000).toISOString()}`);
