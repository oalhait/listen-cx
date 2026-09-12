import type { Provider } from "./urls.js";

export interface PublishingSecrets {
  SPOTIFY_PUBLISHING_ENABLED?: string;
  APPLE_PUBLISHING_ENABLED?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_REFRESH_TOKEN?: string;
  APPLE_DEVELOPER_TOKEN?: string;
  APPLE_MUSIC_USER_TOKEN?: string;
  PUBLISHER_ENCRYPTION_KEY?: string;
}

export function availablePublishers(env: PublishingSecrets): Provider[] {
  const providers: Provider[] = [];
  if (env.SPOTIFY_PUBLISHING_ENABLED === "true" && env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET
    && env.SPOTIFY_REFRESH_TOKEN && typeof env.PUBLISHER_ENCRYPTION_KEY === "string"
    && /^[A-Za-z0-9+/]{43}=$/.test(env.PUBLISHER_ENCRYPTION_KEY)) providers.push("spotify");
  if (env.APPLE_PUBLISHING_ENABLED === "true" && env.APPLE_DEVELOPER_TOKEN && env.APPLE_MUSIC_USER_TOKEN) providers.push("apple");
  return providers;
}
