import { DurableObject } from "cloudflare:workers";
import { D1PublicationStore } from "./publication-db.js";
import { runPublication, type ProviderPublishers } from "./publication-runner.js";
import { availablePublishers, availableConnections, type PublishingSecrets } from "./publishing-bindings.js";
import { MusicConnectionStore } from "./music-connection-store.js";
import type { Provider } from "./urls.js";
import { SpotifyPublisher, PublishingError, type Destination as SpotifyDestination } from "./publishing/spotify/publisher.js";
import { refreshSpotifyAccessToken, type SpotifyTokens } from "./publishing/spotify/credentials.js";
import { ApplePublisher, type Destination as AppleDestination } from "./publishing/apple/publisher.js";

export type RuntimeEnv = Omit<Env, keyof PublishingSecrets> & PublishingSecrets;
type StoredCredentials = SpotifyTokens & { seedFingerprint: string };
type EncryptedCredentials = { iv: string; ciphertext: string };
const credentialKey = "_credentials";
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));

export async function wakeDue(env: RuntimeEnv, capability?: string): Promise<void> {
  const targets = await new D1PublicationStore(env.DB).due(capability);
  const results = await Promise.allSettled(targets.map(target => env.THREAD_PUBLISHER.getByName(target.publisherKey).wake(target.publisherKey)));
  if (results.some(result => result.status === "rejected")) throw new Error("publisher_wake_failed");
}

export class ThreadPublisher extends DurableObject<RuntimeEnv> {
  #tokenRefresh: Promise<string> | undefined;
  #connectionStore: MusicConnectionStore | undefined;
  #operationBusy = false;

  #connections(publisherKey: string): MusicConnectionStore {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(publisherKey) || publisherKey === credentialKey
      || !this.ctx.id.equals(this.env.THREAD_PUBLISHER.idFromName(publisherKey))) throw new Error("publisher_key_mismatch");
    return this.#connectionStore ??= new MusicConnectionStore(this.ctx.storage, this.env, publisherKey);
  }

  async connectionStatus(publisherKey: string, provider: Provider) {
    return this.#connections(publisherKey).status(provider);
  }

  async beginSpotifyConnection(publisherKey: string, capability: string, browserHash: string, redirectUri: string) {
    return this.#connections(publisherKey).beginSpotify(capability, browserHash, redirectUri);
  }

  async finishSpotifyConnection(publisherKey: string, nonce: string, browserHash: string, code: string): Promise<void> {
    const connections = this.#connections(publisherKey);
    if (this.#operationBusy) throw new Error("connection_busy");
    this.#operationBusy = true;
    try { await connections.finishSpotify(nonce, browserHash, code); }
    finally { this.#operationBusy = false; }
  }

  async authorizeAppleConnection(publisherKey: string, musicUserToken: string): Promise<void> {
    const connections = this.#connections(publisherKey);
    if (this.#operationBusy) throw new Error("connection_busy");
    this.#operationBusy = true;
    try {
      const destination = await this.ctx.storage.get<AppleDestination>(`apple:${publisherKey}`);
      if (destination?.intent?.kind === "create" && !destination.providerPlaylistId) throw new Error("create_unresolved");
      await connections.authorizeApple(musicUserToken, destination?.providerPlaylistId ?? undefined);
    } finally { this.#operationBusy = false; }
  }

  async wake(publisherKey: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(publisherKey) || publisherKey === credentialKey) throw new Error("invalid_publisher_key");
    if (!this.ctx.id.equals(this.env.THREAD_PUBLISHER.idFromName(publisherKey))) throw new Error("publisher_key_mismatch");
    await this.ctx.storage.transaction(async storage => {
      await storage.put("publisherKey", publisherKey);
      const alarm = await storage.getAlarm();
      const now = Date.now() + 1;
      if (alarm === null || alarm > now) await storage.setAlarm(now);
    });
  }

  async alarm(): Promise<void> {
    const publisherKey = await this.ctx.storage.get<string>("publisherKey");
    if (!publisherKey) return;
    if (this.#operationBusy) {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      return;
    }
    this.#operationBusy = true;
    let retryAt: number | null;
    try { retryAt = await runPublication(this.env.DB, publisherKey, this.#publishers(publisherKey)); }
    finally { this.#operationBusy = false; }
    if (retryAt !== null) {
      await this.ctx.storage.transaction(async storage => {
        const alarm = await storage.getAlarm();
        if (alarm === null || alarm > retryAt) await storage.setAlarm(retryAt);
      });
    }
  }

  async spotifyAccessToken(): Promise<string> {
    if (!this.ctx.id.equals(this.env.THREAD_PUBLISHER.idFromName(credentialKey))) throw new Error("credentials_object_required");
    if (!availablePublishers(this.env).includes("spotify")) throw new PublishingError("authorization_required", 401);
    if (this.#tokenRefresh) return this.#tokenRefresh;
    this.#tokenRefresh = this.#refreshToken();
    try { return await this.#tokenRefresh; }
    finally { this.#tokenRefresh = undefined; }
  }

  async #refreshToken(): Promise<string> {
    const credentials = { clientId: this.env.SPOTIFY_CLIENT_ID!, clientSecret: this.env.SPOTIFY_CLIENT_SECRET!, refreshToken: this.env.SPOTIFY_REFRESH_TOKEN! };
    const seedFingerprint = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(credentials)))));
    const key = await crypto.subtle.importKey("raw", decode(this.env.PUBLISHER_ENCRYPTION_KEY!), "AES-GCM", false, ["encrypt", "decrypt"]);
    const encrypted = await this.ctx.storage.get<EncryptedCredentials>("spotifyCredentials");
    let stored: StoredCredentials | undefined;
    if (encrypted) {
      try {
        const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(encrypted.iv), additionalData: new TextEncoder().encode(credentialKey) }, key, decode(encrypted.ciphertext));
        stored = JSON.parse(new TextDecoder().decode(plaintext));
      } catch { throw new PublishingError("authorization_required", 401); }
    }
    if (stored?.seedFingerprint === seedFingerprint) {
      if (stored.expiresAt > Date.now() + 60_000) return stored.accessToken;
      credentials.refreshToken = stored.refreshToken;
    }
    const tokens = await refreshSpotifyAccessToken(credentials);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(credentialKey) }, key,
      new TextEncoder().encode(JSON.stringify({ ...tokens, seedFingerprint })));
    await this.ctx.storage.put("spotifyCredentials", { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) });
    return tokens.accessToken;
  }

  #publishers(publisherKey: string): ProviderPublishers {
    const publishers: ProviderPublishers = {};
    const personal = availableConnections(this.env);
    const available = this.env.MUSIC_ACCOUNT_CONNECTIONS_ENABLED === "true" ? personal : availablePublishers(this.env);
    if (available.includes("spotify")) {
      const publisher = new SpotifyPublisher({
        accessToken: () => personal.includes("spotify")
          ? this.#connections(publisherKey).spotifyAccessToken()
          : this.env.THREAD_PUBLISHER.getByName(credentialKey).spotifyAccessToken(),
        store: { get: key => this.ctx.storage.get<SpotifyDestination>(`spotify:${key}`),
          set: (key, value) => this.ctx.storage.put(`spotify:${key}`, value) },
      });
      publishers.spotify = async input => {
        await publisher.reconcile(input);
        const observed = await publisher.observe(input.playlistKey);
        if (!observed.matchesDesired) {
          const destination = await this.ctx.storage.get<SpotifyDestination>(`spotify:${input.playlistKey}`);
          if (destination) await this.ctx.storage.put(`spotify:${input.playlistKey}`, { ...destination, appliedRevision: null });
        }
        if (!observed.matchesDesired || observed.revision !== input.revision || observed.appliedRevision !== input.revision) throw new PublishingError("readback_invalid", 502);
        return { revision: input.revision, playlistId: observed.providerPlaylistId,
          playlistUrl: `https://open.spotify.com/playlist/${observed.providerPlaylistId}` };
      };
    }
    if (available.includes("apple")) {
      const publisher = new ApplePublisher({
        credentials: () => personal.includes("apple")
          ? this.#connections(publisherKey).appleCredentials()
          : Promise.resolve({ developerToken: this.env.APPLE_DEVELOPER_TOKEN!, musicUserToken: this.env.APPLE_MUSIC_USER_TOKEN! }),
        store: { get: key => this.ctx.storage.get<AppleDestination>(`apple:${key}`),
          set: (key, value) => this.ctx.storage.put(`apple:${key}`, value) },
      });
      publishers.apple = async input => {
        const result = await publisher.reconcile(input);
        if (result.appliedRevision !== input.revision || !result.providerPlaylistId || !result.verifiedUrl) throw new PublishingError("readback_invalid", 502);
        return { revision: result.appliedRevision, playlistId: result.providerPlaylistId, playlistUrl: result.verifiedUrl };
      };
    }
    return publishers;
  }
}
