import { DurableObject } from "cloudflare:workers";

export class ThreadLive extends DurableObject {
  fetch(): Response {
    return new Response("This legacy endpoint is retired.", { status: 410 });
  }

  async alarm(): Promise<void> {}
}
