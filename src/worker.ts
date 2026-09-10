import { D1LinkStore } from "./db.js";
import { ItunesClient } from "./itunes.js";
import { Resolver } from "./resolve.js";
import { SpotifyClient } from "./spotify.js";
import { createApp } from "./app.js";

export function getWorkerBaseUrl(env: { BASE_URL: string }, requestUrl: string): string {
  const request = new URL(requestUrl);
  if (["localhost", "127.0.0.1", "[::1]"].includes(request.hostname)) {
    return request.origin;
  }
  return (env.BASE_URL || request.origin).replace(/\/$/, "");
}

export default {
  fetch(request, env) {
    return createApp({
      resolver: new Resolver(new SpotifyClient(), new ItunesClient()),
      store: new D1LinkStore(env.DB),
      baseUrl: getWorkerBaseUrl(env, request.url),
    }).fetch(request);
  },
} satisfies ExportedHandler<Env>;
