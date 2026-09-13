import { expect, it } from "vitest";
import { availablePublishers, availableConnections } from "./publishing-bindings.js";

it("offers personal authorization from app configuration without sharing publisher account tokens", () => {
  const configured = { MUSIC_ACCOUNT_CONNECTIONS_ENABLED: "true", SPOTIFY_PUBLISHING_ENABLED: "true", APPLE_PUBLISHING_ENABLED: "true", SPOTIFY_CLIENT_ID: "client", APPLE_MUSIC_KEY_ID: "key", APPLE_MUSIC_TEAM_ID: "team", APPLE_MUSIC_PRIVATE_KEY_P8: "private", PUBLISHER_ENCRYPTION_KEY: btoa("k".repeat(32)) };
  expect(availableConnections(configured)).toEqual(["spotify", "apple"]);
  expect(availableConnections({ ...configured, MUSIC_ACCOUNT_CONNECTIONS_ENABLED: "false" })).toEqual([]);
  expect(availableConnections({ ...configured, PUBLISHER_ENCRYPTION_KEY: "bad" })).toEqual([]);
  expect(availableConnections({ ...configured, APPLE_MUSIC_PRIVATE_KEY_P8: undefined })).toEqual(["spotify"]);
});
it("requires an explicit enable flag and all publisher credentials", () => {
  const secrets = { SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret", SPOTIFY_REFRESH_TOKEN: "refresh", PUBLISHER_ENCRYPTION_KEY: btoa("k".repeat(32)), APPLE_DEVELOPER_TOKEN: "developer", APPLE_MUSIC_USER_TOKEN: "user" };
  expect(availablePublishers(secrets)).toEqual([]);
  expect(availablePublishers({ ...secrets, SPOTIFY_PUBLISHING_ENABLED: "true" })).toEqual(["spotify"]);
  expect(availablePublishers({ ...secrets, APPLE_PUBLISHING_ENABLED: "true" })).toEqual(["apple"]);
  expect(availablePublishers({ ...secrets, SPOTIFY_PUBLISHING_ENABLED: "true", PUBLISHER_ENCRYPTION_KEY: undefined })).toEqual([]);
});

it.each(["key", btoa("k".repeat(16)), btoa("k".repeat(24)), btoa("k".repeat(33)), "!".repeat(44)])("rejects invalid encryption keys: %s", key => {
  expect(availablePublishers({ SPOTIFY_PUBLISHING_ENABLED: "true", SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret", SPOTIFY_REFRESH_TOKEN: "refresh", PUBLISHER_ENCRYPTION_KEY: key })).toEqual([]);
});
