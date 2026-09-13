import { expect, it } from 'vitest';
import { normalizeProfile, providerProfile } from './profile.js';

it('normalizes editable public names and optional HTTPS photos', () => {
  expect(normalizeProfile({ displayName: '  Omar  ', avatarUrl: '' })).toEqual({ displayName: 'Omar', avatarUrl: null });
  expect(normalizeProfile({ displayName: 'عمر', avatarUrl: 'https://example.com/photo.jpg' })).toEqual({ displayName: 'عمر', avatarUrl: 'https://example.com/photo.jpg' });
});
it('rejects empty, oversized and control-bearing names and unsafe photo URLs', () => {
  for (const displayName of ['', ' ', 'a'.repeat(81), 'a\nb', null]) expect(() => normalizeProfile({ displayName, avatarUrl: null })).toThrow();
  for (const avatarUrl of ['http://example.com', 'javascript:alert(1)', 'https://user:pass@example.com/a', 'data:image/png,hi', 3]) expect(() => normalizeProfile({ displayName: 'Omar', avatarUrl })).toThrow();
});
it('imports only public provider profile fields and never substitutes private identifiers', () => {
  expect(providerProfile({ id: 'private', account_id: 'private', email: 'private@example.com', display_name: null })).toEqual({ displayName: 'Listener', avatarUrl: null });
  expect(providerProfile({ display_name: 'Omar', images: [{ url: 'javascript:bad' }, { url: 'https://i.scdn.co/image/photo' }] })).toEqual({ displayName: 'Omar', avatarUrl: 'https://i.scdn.co/image/photo' });
});
