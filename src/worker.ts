import { D1LinkStore } from "./db.js";
import { ItunesClient } from "./itunes.js";
import { Resolver } from "./resolve.js";
import { SpotifyClient } from "./spotify.js";
import { createApp } from "./app.js";
import { D1ThreadStore } from "./thread-db.js";
import { DurableObjectThreadRealtime, ThreadLive } from "./thread-live.js";
import { WebPushThreadNotifier } from "./thread-push.js";
import {
  AppleMusicMirrorClient,
  createAppleMusicDeveloperToken,
  type AppleMusicDeveloperTokenConfig,
} from "./apple-music-mirror.js";
export { ThreadLive } from "./thread-live.js";
import {
  createCloudflareAttemptLimiter,
  type AttemptLimiter,
} from "./thread-security.js";

interface ThreadLimiterBindings {
  THREAD_CREATE_RATE_LIMITER: RateLimit;
  THREAD_CONTRIBUTION_RATE_LIMITER: RateLimit;
}

interface ThreadConfigurationBindings {
  THREADS_ENABLED: boolean;
  THREAD_MAX_THREADS: number;
}

interface AppleMusicBindings {
  APPLE_MUSIC_ENABLED?: boolean;
  APPLE_MUSIC_TEAM_ID?: string;
  APPLE_MUSIC_KEY_ID?: string;
  APPLE_MUSIC_PRIVATE_KEY_P8?: string;
  APPLE_MUSIC_ALLOWED_ORIGINS?: string;
}

export interface ThreadLimiters {
  creation: AttemptLimiter;
  contribution: AttemptLimiter;
}

type WorkerApp = ReturnType<typeof createApp>;

let appCache:
  | {
      baseUrl: string;
      db: D1Database;
      creationLimiter: RateLimit;
      contributionLimiter: RateLimit;
      maximumThreads: number;
      threadsEnabled: boolean;
      vapidPublicKey: string;
      appleMusicAvailable: boolean;
      app: WorkerApp;
    }
  | undefined;

export function createThreadLimiters(env: ThreadLimiterBindings): ThreadLimiters {
  return {
    creation: createCloudflareAttemptLimiter(
      env.THREAD_CREATE_RATE_LIMITER,
      "thread:create",
      60,
    ),
    contribution: createCloudflareAttemptLimiter(
      env.THREAD_CONTRIBUTION_RATE_LIMITER,
      "thread:contribute",
      60,
    ),
  };
}

export function getThreadMaximum(env: ThreadConfigurationBindings): number {
  if (!Number.isSafeInteger(env.THREAD_MAX_THREADS) || env.THREAD_MAX_THREADS < 1) {
    throw new Error("THREAD_MAX_THREADS must be a positive integer");
  }
  return env.THREAD_MAX_THREADS;
}

export function getWorkerBaseUrl(env: Pick<Env, "BASE_URL">, requestUrl: string): string {
  const request = new URL(requestUrl);
  if (["localhost", "127.0.0.1", "[::1]"].includes(request.hostname)) {
    return request.origin;
  }
  return (env.BASE_URL || request.origin).replace(/\/$/, "");
}

export function getWorkerApp(env: Env, requestUrl: string): WorkerApp {
  const notificationEnv = env as Env & { VAPID_PRIVATE_KEY?: string };
  const appleEnv = env as Env & AppleMusicBindings;
  const baseUrl = getWorkerBaseUrl(env, requestUrl);
  const maximumThreads = getThreadMaximum(env);
  const appleMusicConfig = getAppleMusicConfig(appleEnv);
  if (
    appCache?.baseUrl === baseUrl &&
    appCache.db === env.DB &&
    appCache.creationLimiter === env.THREAD_CREATE_RATE_LIMITER &&
    appCache.contributionLimiter === env.THREAD_CONTRIBUTION_RATE_LIMITER &&
    appCache.maximumThreads === maximumThreads &&
    appCache.threadsEnabled === env.THREADS_ENABLED && appCache.vapidPublicKey === env.VAPID_PUBLIC_KEY &&
    appCache.appleMusicAvailable === Boolean(appleMusicConfig)
  ) {
    return appCache.app;
  }

  const app = createApp({
    resolver: new Resolver(new SpotifyClient(), new ItunesClient()),
    store: new D1LinkStore(env.DB),
    threadStore: new D1ThreadStore(env.DB, { maxThreads: maximumThreads }),
    threadLimiters: createThreadLimiters(env),
    threadEvents: {
      emit(event) {
        console.log(JSON.stringify(event));
      },
    },
    threadRealtime: new DurableObjectThreadRealtime(env.THREAD_LIVE! as unknown as DurableObjectNamespace),
    threadPushNotifier: notificationEnv.VAPID_PRIVATE_KEY
      ? new WebPushThreadNotifier(
          new D1ThreadStore(env.DB, { maxThreads: maximumThreads }),
          {
            subject: env.VAPID_SUBJECT,
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: notificationEnv.VAPID_PRIVATE_KEY,
          },
        )
      : undefined,
    appleMusic: appleMusicConfig
      ? (() => {
          const client = new AppleMusicMirrorClient({ developerTokenConfig: appleMusicConfig });
          return {
            getDeveloperToken: () => createAppleMusicDeveloperToken(appleMusicConfig),
            createThreadPlaylist: (userToken: string, threadTitle: string, trackIds: readonly string[]) =>
              client.createPlaylist(
                userToken,
                `listen.cx — ${threadTitle}`,
                [...trackIds],
                "A staging playlist mirrored from a listen.cx Thread.",
              ),
          };
        })()
      : undefined,
    threadsEnabled: env.THREADS_ENABLED,
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    baseUrl,
  });
  appCache = {
    baseUrl,
    db: env.DB,
    creationLimiter: env.THREAD_CREATE_RATE_LIMITER,
    contributionLimiter: env.THREAD_CONTRIBUTION_RATE_LIMITER,
    maximumThreads,
    threadsEnabled: env.THREADS_ENABLED,
    vapidPublicKey: env.VAPID_PUBLIC_KEY,
    appleMusicAvailable: Boolean(appleMusicConfig),
    app,
  };
  return app;
}

function getAppleMusicConfig(env: AppleMusicBindings): AppleMusicDeveloperTokenConfig | undefined {
  if (!env.APPLE_MUSIC_ENABLED) return undefined;
  const teamId = env.APPLE_MUSIC_TEAM_ID?.trim();
  const keyId = env.APPLE_MUSIC_KEY_ID?.trim();
  const privateKeyP8 = env.APPLE_MUSIC_PRIVATE_KEY_P8;
  const allowedOrigins = env.APPLE_MUSIC_ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!teamId || !keyId || !privateKeyP8 || !allowedOrigins?.length) {
    console.error(JSON.stringify({ message: "Apple Music staging configuration is incomplete" }));
    return undefined;
  }
  return { teamId, keyId, privateKeyP8, allowedOrigins };
}

export default {
  fetch(request, env, ctx) {
    return getWorkerApp(env, request.url).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
