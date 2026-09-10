import { homedir } from "node:os";
import { join } from "node:path";
import { createHarness } from "./harness.ts";

const harness = await createHarness({
  clientId: process.env.SPOTIFY_CLIENT_ID ?? "",
  publisherId: process.env.SPOTIFY_PUBLISHER_ID || undefined,
  controlToken: process.env.SPOTIFY_SPIKE_CONTROL_TOKEN ?? "",
  appMode: process.env.SPOTIFY_APP_MODE as "development" | "extended-quota",
  redirectUri: process.env.SPOTIFY_REDIRECT_URI ?? "http://127.0.0.1:8789/auth/callback",
  stateDirectory: process.env.SPOTIFY_SPIKE_STATE_DIR ?? join(homedir(), ".local", "state", "songlink", "spotify-publisher"),
});
console.log(`Spotify publishing spike listening at ${await harness.listen()}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void harness.close().then(() => process.exit(0)); });
