import { DurableObject } from "cloudflare:workers";

export { default, ThreadPublisher } from "./worker.js";

// Keep the retired staging namespace and its data without restoring live Threads.
export class ThreadLive extends DurableObject {
  fetch(): Response {
    return new Response("This legacy endpoint is retired.", { status: 410 });
  }

  async alarm(): Promise<void> {}
}
