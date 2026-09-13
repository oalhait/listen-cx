import { seal, unseal, makePkce, spotifyAuthorizeUrl, exchangeSpotifyCode, refreshSpotifyTokens, getSpotifyAccount, applePreflight, signAppleDeveloperToken, MusicAuthError, type Sealed } from "./music-auth.js";
import { availableConnections, type PublishingSecrets } from "./publishing-bindings.js";
import type { SpotifyTokens } from "./publishing/spotify/credentials.js";
import type { Provider } from "./urls.js";

export type OAuthReturn = { publisherKey: string; capability: string; nonce: string; expiresAt: number };
type OAuthPending = OAuthReturn & { browserHash: string; verifier: string; redirectUri: string };
type SpotifyAccount = { clientId: string; accountId: string; label: string; tokens: SpotifyTokens };
type AppleAccount = { teamId: string; musicUserToken: string; storefront: string };

export async function appleDeveloperToken(env: PublishingSecrets): Promise<string> {
  if (!availableConnections(env).includes("apple")) throw new MusicAuthError("provider_unavailable", 503);
  return signAppleDeveloperToken({ keyId: env.APPLE_MUSIC_KEY_ID!, teamId: env.APPLE_MUSIC_TEAM_ID!, privateKey: env.APPLE_MUSIC_PRIVATE_KEY_P8! });
}

export class MusicConnectionStore {
  #refresh: Promise<string> | undefined;
  constructor(private storage: DurableObjectStorage, private env: PublishingSecrets, private publisherKey: string) {}

  async status(provider: Provider): Promise<{ authorized: boolean; accountLabel?: string }> {
    if (!availableConnections(this.env).includes(provider)) return { authorized: false };
    try {
      if (provider === "spotify") {
        const account = await this.read<SpotifyAccount>("spotify-account");
        return account && account.clientId === this.env.SPOTIFY_CLIENT_ID ? { authorized: true, accountLabel: account.label } : { authorized: false };
      }
      const account = await this.read<AppleAccount>("apple-account");
      return account && account.teamId === this.env.APPLE_MUSIC_TEAM_ID ? { authorized: true, accountLabel: `Apple Music · ${account.storefront.toUpperCase()}` } : { authorized: false };
    } catch { return { authorized: false }; }
  }

  async beginSpotify(capability: string, browserHash: string, redirectUri: string): Promise<{ url: string; nonce: string }> {
    if (!availableConnections(this.env).includes("spotify")) throw new MusicAuthError("provider_unavailable", 503);
    const pkce = await makePkce();
    const pending: OAuthPending = { publisherKey: this.publisherKey, capability, nonce: crypto.randomUUID(), expiresAt: Date.now() + 600_000, browserHash, verifier: pkce.verifier, redirectUri };
    await this.write("spotify-pending", pending);
    const state = await seal(this.env.PUBLISHER_ENCRYPTION_KEY!, "spotify-return", {
      publisherKey: pending.publisherKey, capability, nonce: pending.nonce, expiresAt: pending.expiresAt,
    } satisfies OAuthReturn);
    return { url: spotifyAuthorizeUrl(this.env.SPOTIFY_CLIENT_ID!, redirectUri, `threads.${btoa(JSON.stringify(state))}`, pkce.challenge), nonce: pending.nonce };
  }

  async finishSpotify(nonce: string, browserHash: string, code: string): Promise<void> {
    const pending = await this.read<OAuthPending>("spotify-pending");
    if (!pending || pending.nonce !== nonce || pending.browserHash !== browserHash || pending.expiresAt <= Date.now()) throw new MusicAuthError("invalid_callback", 400);
    await this.storage.delete("spotify-pending");
    const tokens = await exchangeSpotifyCode({ clientId: this.env.SPOTIFY_CLIENT_ID!, redirectUri: pending.redirectUri, code, verifier: pending.verifier });
    const profile = await getSpotifyAccount(tokens.accessToken);
    const previous = await this.read<SpotifyAccount>("spotify-account");
    if (previous && (previous.accountId !== profile.accountId || previous.clientId !== this.env.SPOTIFY_CLIENT_ID)) throw new MusicAuthError("different_account", 409);
    await this.write("spotify-account", { clientId: this.env.SPOTIFY_CLIENT_ID!, accountId: profile.accountId, label: profile.label, tokens } satisfies SpotifyAccount);
  }

  async authorizeApple(musicUserToken: string, playlistId?: string): Promise<void> {
    if (typeof musicUserToken !== "string" || !/^[\x21-\x7e]{1,12000}$/.test(musicUserToken)) throw new MusicAuthError("invalid_authorization", 400);
    const developerToken = await appleDeveloperToken(this.env);
    const preflight = await applePreflight(developerToken, musicUserToken, playlistId);
    await this.write("apple-account", { teamId: this.env.APPLE_MUSIC_TEAM_ID!, musicUserToken, storefront: preflight.storefront } satisfies AppleAccount);
  }

  async spotifyAccessToken(): Promise<string> {
    if (this.#refresh) return this.#refresh;
    this.#refresh = this.refreshSpotify();
    try { return await this.#refresh; } finally { this.#refresh = undefined; }
  }

  private async refreshSpotify(): Promise<string> {
    const account = await this.read<SpotifyAccount>("spotify-account");
    if (!account || account.clientId !== this.env.SPOTIFY_CLIENT_ID) throw new MusicAuthError("authorization_required", 401);
    if (account.tokens.expiresAt > Date.now() + 60_000) return account.tokens.accessToken;
    const tokens = await refreshSpotifyTokens({ clientId: account.clientId, refreshToken: account.tokens.refreshToken });
    await this.write("spotify-account", { ...account, tokens });
    return tokens.accessToken;
  }

  async appleCredentials(): Promise<{ developerToken: string; musicUserToken: string }> {
    const account = await this.read<AppleAccount>("apple-account");
    if (!account || account.teamId !== this.env.APPLE_MUSIC_TEAM_ID) throw new MusicAuthError("authorization_required", 401);
    return { developerToken: await appleDeveloperToken(this.env), musicUserToken: account.musicUserToken };
  }

  private async read<T>(name: string): Promise<T | undefined> {
    const envelope = await this.storage.get<Sealed>(name);
    return envelope ? unseal<T>(this.env.PUBLISHER_ENCRYPTION_KEY!, `${this.publisherKey}:${name}`, envelope) : undefined;
  }

  private async write(name: string, value: unknown): Promise<void> {
    await this.storage.put(name, await seal(this.env.PUBLISHER_ENCRYPTION_KEY!, `${this.publisherKey}:${name}`, value));
  }
}
