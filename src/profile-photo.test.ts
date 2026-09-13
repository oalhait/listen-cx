import { expect, it } from 'vitest';
import { decodeProfilePhoto } from './profile-photo.js';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=';
it('accepts bounded PNG uploads and rejects active content, invalid encoding, and oversized images', () => {
  expect(decodeProfilePhoto(png)).toBeInstanceOf(Uint8Array);
  for (const invalid of ['', 'invalid', btoa('<svg onload="alert(1)"></svg>'), 'a'.repeat(262149), null]) expect(() => decodeProfilePhoto(invalid)).toThrow();
  const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
  new DataView(bytes.buffer).setUint32(16, 10000);
  expect(() => decodeProfilePhoto(btoa(String.fromCharCode(...bytes)))).toThrow();
});
