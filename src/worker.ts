import { D1LinkStore } from "./db.js";
import { ItunesClient } from "./itunes.js";
import { Resolver } from "./resolve.js";
import { SpotifyClient } from "./spotify.js";
import { createApp } from "./app.js";

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
