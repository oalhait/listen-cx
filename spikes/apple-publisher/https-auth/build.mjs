import { mkdir, copyFile, readdir } from 'node:fs/promises';

const output = new URL('../.local/https-assets/', import.meta.url);
await mkdir(output, { recursive: true, mode: 0o700 });
for (const [source, name] of [['probe.html', 'index.html'], ['probe.mjs', 'probe.mjs'], ['../web-authorization.mjs', 'web-authorization.mjs'], ['control.html', 'control.html'], ['control.mjs', 'control.mjs'], ['message-diagnostic.mjs', 'message-diagnostic.mjs']]) {
  await copyFile(new URL(source, import.meta.url), new URL(name, output));
}
if ((await readdir(output)).sort().join(',') !== 'control.html,control.mjs,index.html,message-diagnostic.mjs,probe.mjs,web-authorization.mjs') throw new Error('Unexpected file in isolated probe assets');
