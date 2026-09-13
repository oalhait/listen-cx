import { D1PublicationStore } from "./publication-db.js";
import { D1ThreadStore } from "./thread-db.js";
import { D1LinkStore } from "./db.js";
import { ItunesClient } from "./itunes.js";
import { Resolver } from "./resolve.js";
import { SpotifyClient } from "./spotify.js";
import { createApp } from "./app.js";
import { D1JamStore } from "./jam-db.js";
import {
  appleMusicConfigFromEnv,
  createAppleMusicDeveloperToken,
  type AppleMusicAuthEnv,
} from "./apple-music-auth.js";

type ListenEnv = Env & AppleMusicAuthEnv;
import { availableConnections, type PublishingSecrets } from "./publishing-bindings.js";
import { createMusicConnectionsApp, requireMusicConnection } from "./music-connections-app.js";
import { wakeDue } from "./thread-publisher.js";

export { ThreadPublisher } from "./thread-publisher.js";

export function getWorkerBaseUrl(env: { BASE_URL: string }, requestUrl: string): string {
  const request = new URL(requestUrl);
  if (["localhost", "127.0.0.1", "[::1]"].includes(request.hostname)) {
    return request.origin;
  }
  return (env.BASE_URL || request.origin).replace(/\/$/, "");
}

function createAppleMusicIssuer(env: ListenEnv) {
  const values = [
    env.APPLE_MUSIC_TEAM_ID,
    env.APPLE_MUSIC_KEY_ID,
    env.APPLE_MUSIC_PRIVATE_KEY_P8,
    env.APPLE_MUSIC_ALLOWED_ORIGINS,
    env.APPLE_MUSIC_MEDIA_ID,
  ];
  if (values.every((value) => !value)) return undefined;

  try {
    const config = appleMusicConfigFromEnv(env);
    return {
      allowedOrigins: config.allowedOrigins,
      issueDeveloperToken: () => createAppleMusicDeveloperToken(config),
    };
  } catch {
    console.error("Apple Music configuration is invalid.");
    return undefined;
  }
}

export function jamsAreEnabled(value: unknown, requestUrl: string): boolean {
  const hostname = new URL(requestUrl).hostname;
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
    && String(value).trim().toLowerCase() === "true";
}

export default {
  fetch(request, env, ctx) {
    const baseUrl = getWorkerBaseUrl(env, request.url);
    const onChange = (capability: string) => { ctx.waitUntil(wakeDue(env, capability)); };
    return createApp({
      resolver: new Resolver(new SpotifyClient(), new ItunesClient()),
      store: new D1LinkStore(env.DB),
      jamStore: new D1JamStore(env.DB, { maxJams: 10_000 }),
      jamsEnabled: jamsAreEnabled(env.JAMS_ENABLED, request.url),
      threadStore: new D1ThreadStore(env.DB),
      appleMusic: createAppleMusicIssuer(env),
      baseUrl,
      connections: createMusicConnectionsApp(env, baseUrl, onChange),
      publishing: {
        availableProviders: availableConnections(env),
        onChange,
        requireConnection: (authorization, provider) => requireMusicConnection(env, authorization, provider),
        retry: (authorization, provider) => new D1PublicationStore(env.DB).retry(authorization, provider),
      },
    }).fetch(request);
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(wakeDue(env));
  },
} satisfies ExportedHandler<ListenEnv & PublishingSecrets>;
