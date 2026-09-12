import { mkdir, copyFile, readdir } from 'node:fs/promises';

const output = new URL('../.local/https-assets/', import.meta.url);
const assets = [['probe.html', 'index.html'], ['probe.mjs', 'probe.mjs'], ['../web-authorization.mjs', 'web-authorization.mjs'], ['control.html', 'control.html'], ['control.mjs', 'control.mjs'], ['message-diagnostic.mjs', 'message-diagnostic.mjs'], ['credential-pairing.mjs', 'credential-pairing.mjs'], ['same-id.html', 'same-id.html'], ['same-id-control.mjs', 'same-id-control.mjs'], ['same-id.mjs', 'same-id.mjs'], ['replacement.html', 'replacement-sdk.html'], ['replacement.html', 'replacement-direct.html'], ['replacement-control.mjs', 'replacement-control.mjs'], ['replacement-proof.mjs', 'replacement-proof.mjs'], ['transport-observer.mjs', 'transport-observer.mjs']];
await mkdir(output, { recursive: true, mode: 0o700 });
await Promise.all(assets.map(([source, name]) => copyFile(new URL(source, import.meta.url), new URL(name, output))));
if ((await readdir(output)).sort().join(',') !== assets.map(([, name]) => name).sort().join(',')) throw new Error('Unexpected file in isolated probe assets');
