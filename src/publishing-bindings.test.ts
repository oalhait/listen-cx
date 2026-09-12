import { expect, it } from "vitest";
import { availablePublishers } from "./publishing-bindings.js";
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
