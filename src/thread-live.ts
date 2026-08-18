export class ThreadLive {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  publish() {
    const payload = JSON.stringify({ type: "thread-changed" });
    for (const socket of this.state.getWebSockets()) socket.send(payload);
  }
}

export class DurableObjectThreadRealtime {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  connect(request: Request, publicCapability: string) {
    return this.namespace.getByName(publicCapability).fetch(request);
  }

  async publish(publicCapability: string) {
    await (this.namespace.getByName(publicCapability) as unknown as { publish(): Promise<void> }).publish();
  }
}
