import { MusicCatalog, MusicCatalogError } from "./music-catalog.js";
import { resolveAutomaticMatches } from "./automatic-matching.js";
import type { IdentityResolver } from "./publication-runner.js";
import { DurableObject } from "cloudflare:workers";
import { D1PublicationStore } from "./publication-db.js";
import { runLibrarySubscription, runPublication, type ProviderPublishers } from "./publication-runner.js";
import { availablePublishers, availableConnections, type PublishingSecrets } from "./publishing-bindings.js";
import { D1AccountStore } from "./account-db.js";
import { seal, unseal, refreshSpotifyTokens, signAppleDeveloperToken, applePreflight, MusicAuthError } from "./music-auth.js";
import { MusicConnectionStore } from "./music-connection-store.js";
import type { Provider } from "./urls.js";
import { SpotifyPublisher, PublishingError, type Destination as SpotifyDestination } from "./publishing/spotify/publisher.js";
import { refreshSpotifyAccessToken, type SpotifyTokens } from "./publishing/spotify/credentials.js";
import { ApplePublisher, type Destination as AppleDestination } from "./publishing/apple/publisher.js";
import { AppleLibrarySubscriber } from "./publishing/apple/subscriber.js";

export type RuntimeEnv = Omit<Env, keyof PublishingSecrets> & PublishingSecrets;
type SpotifyAccountCredentials = { clientId: string; accountId: string; tokens: SpotifyTokens };
type ApplePublishingCredentials = { developerToken: string; musicUserToken: string; storefront?: string };
type AppleAccountCredentials = { teamId: string; musicUserToken: string; storefront: string };
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
  #appleToken: { value: string; expiresAt: number } | undefined;
  #appleTokenRefresh: Promise<string> | undefined;
  #connectionStore: MusicConnectionStore | undefined;
  #operationBusy = false;
  #accountOperation: Promise<void> = Promise.resolve();

  #validatePublisherKey(publisherKey: string): void {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(publisherKey) || publisherKey === credentialKey
      || !this.ctx.id.equals(this.env.THREAD_PUBLISHER.idFromName(publisherKey))) throw new Error("publisher_key_mismatch");
  }

  #connections(publisherKey: string): MusicConnectionStore {
    this.#validatePublisherKey(publisherKey);
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
    const target = await new D1PublicationStore(this.env.DB).target(publisherKey);
    if (!target) return;
    if (this.#operationBusy) {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      return;
    }
    let retryAt: number | null;
    if (target.accountId && target.provider === "apple") {
      retryAt = await this.env.THREAD_PUBLISHER.getByName(`account_${target.accountId}`).publishAppleSubscription(target.accountId, publisherKey);
    } else {
      this.#operationBusy = true;
      try {
        retryAt = await runPublication(this.env.DB, publisherKey, this.#publishers(publisherKey, target.accountId, target.provider), this.#identityResolver(publisherKey, target.accountId));
        if (target.provider === "apple" && !target.accountId && retryAt === null) await wakeDue(this.env, target.capability);
      }
      finally { this.#operationBusy = false; }
    }
    if (retryAt !== null) {
      await this.ctx.storage.transaction(async storage => {
        const alarm = await storage.getAlarm();
        if (alarm === null || alarm > retryAt) await storage.setAlarm(retryAt);
      });
    }
  }

  #accountStore(accountId: string): D1AccountStore {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)
      || !this.ctx.id.equals(this.env.THREAD_PUBLISHER.idFromName(`account_${accountId}`))) throw new Error("account_object_required");
    return new D1AccountStore(this.env.DB);
  }

  async #serializeAccount<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#accountOperation.then(operation);
    this.#accountOperation = result.then(() => {}, () => {});
    return result;
  }

  async setAccountCredentials(accountId: string, encryptedCredentials: string): Promise<void> {
    const accounts = this.#accountStore(accountId);
    await this.#serializeAccount(() => accounts.setCredentials(accountId, encryptedCredentials));
  }

  async getAccountSpotifyToken(accountId: string): Promise<string> {
    const accounts = this.#accountStore(accountId);
    return this.#serializeAccount(async () => {
      const account = await accounts.account(accountId);
      if (account?.provider !== "spotify" || !account.credentials || this.env.SPOTIFY_PUBLISHING_ENABLED !== "true") throw new MusicAuthError("authorization_required", 401);
      const credentials = await unseal<SpotifyAccountCredentials>(this.env.PUBLISHER_ENCRYPTION_KEY!, `account:${accountId}`, JSON.parse(account.credentials));
      if (credentials.clientId !== this.env.SPOTIFY_CLIENT_ID || credentials.accountId !== account.subject) throw new MusicAuthError("authorization_required", 401);
      if (credentials.tokens.expiresAt > Date.now() + 60_000) return credentials.tokens.accessToken;
      const tokens = await refreshSpotifyTokens({ clientId: credentials.clientId, refreshToken: credentials.tokens.refreshToken });
      await accounts.setCredentials(accountId, JSON.stringify(await seal(this.env.PUBLISHER_ENCRYPTION_KEY!, `account:${accountId}`, { ...credentials, tokens })));
      return tokens.accessToken;
    });
  }

  async getOptionalAccountSpotifyToken(accountId: string): Promise<string | null> {
    try { return await this.getAccountSpotifyToken(accountId); }
    catch (error) {
      if (error instanceof MusicAuthError && error.status === 401) return null;
      throw error;
    }
  }

  async getAccountAppleCredentials(accountId: string): Promise<ApplePublishingCredentials> {
    this.#accountStore(accountId);
    return this.#serializeAccount(() => this.#readAccountAppleCredentials(accountId));
  }

  async #readAccountAppleCredentials(accountId: string): Promise<ApplePublishingCredentials> {
    const account = await this.#accountStore(accountId).account(accountId);
    if (account?.provider !== "apple" || !account.credentials || this.env.APPLE_PUBLISHING_ENABLED !== "true") throw new MusicAuthError("authorization_required", 401);
    const credentials = await unseal<AppleAccountCredentials>(this.env.PUBLISHER_ENCRYPTION_KEY!, `account:${accountId}`, JSON.parse(account.credentials));
    if (credentials.teamId !== this.env.APPLE_MUSIC_TEAM_ID) throw new MusicAuthError("authorization_required", 401);
    return { developerToken: await this.#appleDeveloperToken(), musicUserToken: credentials.musicUserToken, storefront: credentials.storefront };
  }

  async #appleDeveloperToken(): Promise<string> {
    if (this.#appleToken && this.#appleToken.expiresAt > Date.now() + 60_000) return this.#appleToken.value;
    if (this.#appleTokenRefresh) return this.#appleTokenRefresh;
    this.#appleTokenRefresh = signAppleDeveloperToken({
      keyId: this.env.APPLE_MUSIC_KEY_ID!, teamId: this.env.APPLE_MUSIC_TEAM_ID!, privateKey: this.env.APPLE_MUSIC_PRIVATE_KEY_P8!,
    }).then(value => {
      this.#appleToken = { value, expiresAt: Date.now() + 15 * 60_000 };
      return value;
    });
    try { return await this.#appleTokenRefresh; }
    finally { this.#appleTokenRefresh = undefined; }
  }

  async publishAppleSubscription(accountId: string, publisherKey: string): Promise<number | null> {
    this.#accountStore(accountId);
    return this.#serializeAccount(async () => {
      const target = await new D1PublicationStore(this.env.DB).target(publisherKey);
      if (!target) return null;
      if (target.accountId !== accountId || target.provider !== "apple") throw new MusicAuthError("authorization_required", 401);
      let credentials: ApplePublishingCredentials;
      try { credentials = await this.#readAccountAppleCredentials(accountId); }
      catch (error) { return runLibrarySubscription(this.env.DB, publisherKey, async () => { throw error; }); }
      return this.env.THREAD_PUBLISHER.getByName(publisherKey).runAppleSubscription(publisherKey, accountId, credentials);
    });
  }

  async runAppleSubscription(publisherKey: string, accountId: string, credentials: ApplePublishingCredentials): Promise<number | null> {
    this.#validatePublisherKey(publisherKey);
    if (this.#operationBusy) return Date.now() + 5000;
    this.#operationBusy = true;
    try {
      const target = await new D1PublicationStore(this.env.DB).target(publisherKey);
      if (!target) return null;
      if (target.accountId !== accountId || target.provider !== "apple") throw new MusicAuthError("authorization_required", 401);
      const subscriber = new AppleLibrarySubscriber({ credentials, storefront: credentials.storefront ?? "us" });
      return await runLibrarySubscription(this.env.DB, publisherKey, input => subscriber.reconcile({
        playlistUrl: input.playlistUrl,
        previousPlaylistUrl: input.previousPlaylistUrl,
      }));
    } finally { this.#operationBusy = false; }
  }

  async authorizeAccountApple(accountId: string, musicUserToken: string): Promise<void> {
    const accounts = this.#accountStore(accountId);
    return this.#serializeAccount(async () => {
      const account = await accounts.account(accountId);
      if (account?.provider !== "apple" || this.env.APPLE_PUBLISHING_ENABLED !== "true") throw new MusicAuthError("authorization_required", 401);
      const developerToken = await this.#appleDeveloperToken();
      const { storefront } = await applePreflight(developerToken, musicUserToken);
      await accounts.setCredentials(accountId, JSON.stringify(await seal(this.env.PUBLISHER_ENCRYPTION_KEY!, `account:${accountId}`, {
        teamId: this.env.APPLE_MUSIC_TEAM_ID!, musicUserToken, storefront,
      } satisfies AppleAccountCredentials)));
    });
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

  #identityResolver(publisherKey: string, accountId: string | null): IdentityResolver {
    return async (view, target) => {
      const service = availablePublishers(this.env);
      let spotifyAccessToken: string | undefined;
      if (target.provider === "spotify") {
        if (accountId) spotifyAccessToken = await this.env.THREAD_PUBLISHER.getByName(`account_${accountId}`).getAccountSpotifyToken(accountId);
        else if (service.includes("spotify")) spotifyAccessToken = await this.env.THREAD_PUBLISHER.getByName(credentialKey).spotifyAccessToken();
        else if (availableConnections(this.env).includes("spotify")) spotifyAccessToken = await this.#connections(publisherKey).spotifyAccessToken();
      } else if (accountId) {
        const spotify = (await new D1AccountStore(this.env.DB).connections(accountId)).find(account => account.provider === "spotify" && account.credentials);
        if (spotify) spotifyAccessToken = await this.env.THREAD_PUBLISHER.getByName(`account_${spotify.id}`).getOptionalAccountSpotifyToken(spotify.id) ?? undefined;
      }
      const developerToken = this.env.APPLE_DEVELOPER_TOKEN
        ?? (this.env.APPLE_MUSIC_KEY_ID && this.env.APPLE_MUSIC_TEAM_ID && this.env.APPLE_MUSIC_PRIVATE_KEY_P8 ? await this.#appleDeveloperToken() : undefined);
      let storefront = this.env.APPLE_MUSIC_STOREFRONT ?? "us";
      if (target.provider === "apple" && !service.includes("apple") && availableConnections(this.env).includes("apple")) {
        storefront = (await this.#connections(publisherKey).appleCredentials()).storefront;
      }
      const catalog = new MusicCatalog({ appleDeveloperToken: developerToken, spotifyAccessToken });
      return resolveAutomaticMatches(this.env.DB, view, target, {
        get: async source => {
          try { return await catalog.get(source); }
          catch (error) {
            if (target.provider !== "apple" || source.provider !== "spotify" || !(error instanceof MusicCatalogError)
              || ![401, 403].includes(error.status)) throw error;
            return new MusicCatalog({ appleDeveloperToken: developerToken }).get(source);
          }
        },
        findMatch: (source, provider, market) => catalog.findMatch(source, provider, market),
      }, storefront);
    };
  }

  #publishers(publisherKey: string, accountId: string | null = null, accountProvider?: Provider): ProviderPublishers {
    const publishers: ProviderPublishers = {};
    const personal = availableConnections(this.env);
    const service = availablePublishers(this.env);
    const available = accountId ? (accountProvider ? [accountProvider] : [])
      : [...new Set([...service, ...personal])];
    if (available.includes("spotify")) {
      const publisher = new SpotifyPublisher({
        accessToken: () => {
          if (accountId) return this.env.THREAD_PUBLISHER.getByName(`account_${accountId}`).getAccountSpotifyToken(accountId);
          if (service.includes("spotify")) return this.env.THREAD_PUBLISHER.getByName(credentialKey).spotifyAccessToken();
          if (personal.includes("spotify")) return this.#connections(publisherKey).spotifyAccessToken();
          return Promise.reject(new PublishingError("authorization_required", 401));
        },
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
        credentials: async () => {
          if (accountId) throw new MusicAuthError("authorization_required", 401);
          if (service.includes("apple")) return {
            developerToken: this.env.APPLE_DEVELOPER_TOKEN ?? await this.#appleDeveloperToken(),
            musicUserToken: this.env.APPLE_MUSIC_USER_TOKEN!,
          };
          if (personal.includes("apple")) return this.#connections(publisherKey).appleCredentials();
          throw new MusicAuthError("authorization_required", 401);
        },
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
