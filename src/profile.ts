import { ThreadError } from './thread.js';

export interface PublicProfile {
  displayName: string;
  avatarUrl: string | null;
}

export function normalizeProfile(value: { displayName: unknown; avatarUrl: unknown }): PublicProfile {
  if (typeof value.displayName !== 'string' || /[\x00-\x1f\x7f]/.test(value.displayName)
    || !value.displayName.trim() || value.displayName.trim().length > 80) {
    throw new ThreadError(400, 'invalid_profile', 'Choose a display name between 1 and 80 characters.');
  }
  let avatarUrl: string | null = null;
  if (value.avatarUrl !== null && value.avatarUrl !== '') {
    try {
      if (typeof value.avatarUrl !== 'string' || value.avatarUrl.length > 2048 || /[\x00-\x20\x7f]/.test(value.avatarUrl)) throw new Error();
      const url = new URL(value.avatarUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
      avatarUrl = url.href;
    } catch { throw new ThreadError(400, 'invalid_profile', 'Use an HTTPS photo URL, or leave it blank.'); }
  }
  return { displayName: value.displayName.trim(), avatarUrl };
}

export function providerProfile(value: { display_name?: unknown; images?: unknown; [key: string]: unknown }): PublicProfile {
  let displayName = 'Listener';
  try { displayName = normalizeProfile({ displayName: value.display_name, avatarUrl: null }).displayName; } catch {}
  for (const image of Array.isArray(value.images) ? value.images : []) {
    try {
      const profile = normalizeProfile({ displayName, avatarUrl: image?.url });
      if (profile.avatarUrl) return profile;
    } catch {}
  }
  return { displayName, avatarUrl: null };
}
