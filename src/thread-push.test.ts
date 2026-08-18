import { describe, expect, it } from "vitest";
import { parseThreadPushSubscription } from "./thread-push.js";

describe("parseThreadPushSubscription", () => {
  it("accepts an HTTPS endpoint and URL-safe subscription keys", () => {
    expect(
      parseThreadPushSubscription({
        endpoint: "https://fcm.googleapis.com/fcm/send/example",
        p256dh: "BJq_p256dh-key",
        auth: "auth_key",
      }),
    ).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/example",
      p256dh: "BJq_p256dh-key",
      auth: "auth_key",
    });
  });

  it("rejects malformed, non-HTTPS, and oversized subscriptions", () => {
    expect(parseThreadPushSubscription(null)).toBeNull();
    expect(
      parseThreadPushSubscription({
        endpoint: "http://push.example/subscription",
        p256dh: "key",
        auth: "auth",
      }),
    ).toBeNull();
    expect(
      parseThreadPushSubscription({
        endpoint: "https://push.example/subscription",
        p256dh: "not+url-safe",
        auth: "auth",
      }),
    ).toBeNull();
  });
});
