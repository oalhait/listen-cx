import { mkdir, copyFile, readdir } from 'node:fs/promises';

const output = new URL('../.local/https-assets/', import.meta.url);
await mkdir(output, { recursive: true, mode: 0o700 });
for (const [source, name] of [['probe.html', 'index.html'], ['probe.mjs', 'probe.mjs'], ['../web-authorization.mjs', 'web-authorization.mjs']]) {
  await copyFile(new URL(source, import.meta.url), new URL(name, output));
}
if ((await readdir(output)).sort().join(',') !== 'index.html,probe.mjs,web-authorization.mjs') throw new Error('Unexpected file in isolated probe assets');
