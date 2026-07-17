import { D1LinkStore } from "./db.js";
import { ItunesClient } from "./itunes.js";
import { Resolver } from "./resolve.js";
import { SpotifyClient } from "./spotify.js";
import { createApp } from "./app.js";
import {
  createCloudflareAttemptLimiter,
  type AttemptLimiter,
} from "./thread-security.js";

interface ThreadLimiterBindings {
  THREAD_CREATE_RATE_LIMITER: RateLimit;
  THREAD_CONTRIBUTION_RATE_LIMITER: RateLimit;
}

interface ThreadConfigurationBindings {
  THREAD_MAX_THREADS: number;
}

export interface ThreadLimiters {
  creation: AttemptLimiter;
  contribution: AttemptLimiter;
}

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

export default {
  fetch(request, env) {
    const baseUrl = env.BASE_URL || new URL(request.url).origin;
    const app = createApp({
      resolver: new Resolver(new SpotifyClient(), new ItunesClient()),
      store: new D1LinkStore(env.DB),
      baseUrl: baseUrl.replace(/\/$/, ""),
    });
    return app.fetch(request);
  },
} satisfies ExportedHandler<Env>;
