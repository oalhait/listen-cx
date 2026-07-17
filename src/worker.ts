import { D1LinkStore } from "./db.js";
import { ItunesClient } from "./itunes.js";
import { Resolver } from "./resolve.js";
import { SpotifyClient } from "./spotify.js";
import { createApp } from "./app.js";
import { D1ThreadStore } from "./thread-db.js";
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

export function getWorkerApp(env: Env, requestUrl: string): WorkerApp {
  const baseUrl = (env.BASE_URL || new URL(requestUrl).origin).replace(/\/$/, "");
  const maximumThreads = getThreadMaximum(env);
  if (
    appCache?.baseUrl === baseUrl &&
    appCache.db === env.DB &&
    appCache.creationLimiter === env.THREAD_CREATE_RATE_LIMITER &&
    appCache.contributionLimiter === env.THREAD_CONTRIBUTION_RATE_LIMITER &&
    appCache.maximumThreads === maximumThreads &&
    appCache.threadsEnabled === env.THREADS_ENABLED
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
    threadsEnabled: env.THREADS_ENABLED,
    baseUrl,
  });
  appCache = {
    baseUrl,
    db: env.DB,
    creationLimiter: env.THREAD_CREATE_RATE_LIMITER,
    contributionLimiter: env.THREAD_CONTRIBUTION_RATE_LIMITER,
    maximumThreads,
    threadsEnabled: env.THREADS_ENABLED,
    app,
  };
  return app;
}

export default {
  fetch(request, env) {
    return getWorkerApp(env, request.url).fetch(request);
  },
} satisfies ExportedHandler<Env>;
