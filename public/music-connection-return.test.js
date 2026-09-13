import { expect, it } from 'vitest';
import { connectionReturnUrl } from './music-connection-return.js';

const origin = 'https://staging.listen.cx';
const path = '/t/abcdefghijklmnopqrstuv/manage/apps';

it('accepts same-origin connection pages with a bounded authorization result', () => {
  for (const result of ['authorized', 'error']) {
    expect(connectionReturnUrl(`${path}?spotify=${result}`, origin)).toBe(`${origin}${path}?spotify=${result}`);
    expect(connectionReturnUrl(`${origin}${path}?spotify=${result}`, origin)).toBe(`${origin}${path}?spotify=${result}`);
  }
});

it('rejects external or non-HTTPS origins, credentials, fragments, and unexpected parameters', () => {
  for (const href of [
    `https://evil.example${path}?spotify=authorized`,
    `http://staging.listen.cx${path}?spotify=authorized`,
    `//evil.example${path}?spotify=authorized`,
    `https://user:password@staging.listen.cx${path}?spotify=authorized`,
    `${path}?spotify=authorized#manage=private`,
    `${path}?spotify=authorized&code=private`,
    `${path}?spotify=error&spotify=authorized`,
    `${path}?spotify=pending`,
    path,
    'javascript:alert(1)',
    '',
  ]) expect(connectionReturnUrl(href, origin)).toBeNull();
});

it('rejects unexpected Thread routes and malformed capabilities', () => {
  for (const href of [
    '/t/short/manage/apps?spotify=authorized',
    '/t/abcdefghijklmnopqrstuvw/manage/apps?spotify=authorized',
    '/t/abcdefghijklmnopqrstu./manage/apps?spotify=authorized',
    '/t/abcdefghijklmnopqrstuv/manage?spotify=authorized',
    '/t/abcdefghijklmnopqrstuv/manage/apps/extra?spotify=authorized',
    '/t/abcdefghijklmnopqrstuv/manage/apps/?spotify=authorized',
    '/threads/new?spotify=authorized',
  ]) expect(connectionReturnUrl(href, origin)).toBeNull();
});
