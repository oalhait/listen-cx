import webpush from "web-push";

export interface ThreadPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface ThreadPushNotifier {
  notifySongAdded(input: {
    publicCapability: string;
    title: string;
    artist: string;
    publicUrl: string;
  }): Promise<void>;
}

const BASE64_URL = /^[A-Za-z0-9_-]+$/;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;

export function parseThreadPushSubscription(value: unknown): ThreadPushSubscription | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const subscription = value as Record<string, unknown>;
  if (
    typeof subscription.endpoint !== "string" ||
    typeof subscription.p256dh !== "string" ||
    typeof subscription.auth !== "string" ||
    subscription.endpoint.length > MAX_ENDPOINT_LENGTH ||
    subscription.p256dh.length > MAX_KEY_LENGTH ||
    subscription.auth.length > MAX_KEY_LENGTH ||
    !BASE64_URL.test(subscription.p256dh) ||
    !BASE64_URL.test(subscription.auth)
  ) {
    return null;
  }

  try {
    const endpoint = new URL(subscription.endpoint);
    if (endpoint.protocol !== "https:") return null;
    return {
      endpoint: endpoint.toString(),
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    };
  } catch {
    return null;
  }
}

export interface ThreadPushSubscriptionStore {
  listPushSubscriptions(publicCapability: string): Promise<ThreadPushSubscription[]>;
  removePushSubscription(publicCapability: string, endpoint: string): Promise<void>;
}

export class WebPushThreadNotifier implements ThreadPushNotifier {
  constructor(
    private readonly store: ThreadPushSubscriptionStore,
    private readonly vapid: { subject: string; publicKey: string; privateKey: string },
  ) {}

  async notifySongAdded(input: {
    publicCapability: string;
    title: string;
    artist: string;
    publicUrl: string;
  }): Promise<void> {
    const subscriptions = await this.store.listPushSubscriptions(input.publicCapability);
    const payload = JSON.stringify({
      title: input.title,
      body: input.artist,
      url: input.publicUrl,
      tag: `thread-${input.publicCapability}`,
    });
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            payload,
            {
              TTL: 300,
              urgency: "normal",
              topic: `thread-${input.publicCapability}`.slice(0, 32),
              vapidDetails: this.vapid,
            },
          );
        } catch (error) {
          const statusCode = error instanceof webpush.WebPushError ? error.statusCode : undefined;
          if (statusCode === 404 || statusCode === 410) {
            await this.store.removePushSubscription(input.publicCapability, subscription.endpoint);
          }
        }
      }),
    );
  }
}
