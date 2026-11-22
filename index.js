// Kulzzy Universal Media Control
import { DurableObject } from "cloudflare:workers";

const ALLOWED_ORIGINS = [
  "https://kulzzy.github.io",
  "https://kulzzy-auto-player.pages.dev",
  "https://kulzzy-radio-main-app.pages.dev",
  "https://kulzzyapp.pages.dev"
];

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin)
      ? origin
      : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (url.pathname === "/health") {
      return Response.json({
        service: "Kulzzy Universal Media Control",
        status: "online"
      });
    }

    // NEW: Durable Object diagnostic
    if (url.pathname === "/diagnostic") {
      if (
        request.method !== "GET" ||
        (origin && !ALLOWED_ORIGINS.includes(origin))
      ) {
        return Response.json(
          { error: "Diagnostic request not permitted" },
          { status: 403, headers: cors(origin) }
        );
      }

      try {
        const id = env.MEDIA_CONTROL.idFromName(
          "kulzzy-global-playback"
        );

        const diagnosticRequest = new Request(
          "https://media-control.internal/diagnostic"
        );

        const result = await env.MEDIA_CONTROL
          .get(id)
          .fetch(diagnosticRequest);

        const data = await result.json();

        return Response.json({
          service: "Kulzzy Universal Media Control",
          worker: "online",
          durableObject: "reachable",
          ...data
        }, {
          headers: {
            ...cors(origin),
            "Cache-Control": "no-store"
          }
        });

      } catch (error) {
        return Response.json({
          service: "Kulzzy Universal Media Control",
          worker: "online",
          durableObject: "error",
          message: String(error && error.message || error)
        }, {
          status: 503,
          headers: {
            ...cors(origin),
            "Cache-Control": "no-store"
          }
        });
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors(origin)
      });
    }

    if (!ALLOWED_ORIGINS.includes(origin)) {
      return Response.json(
        { error: "Origin not permitted" },
        { status: 403, headers: cors(origin) }
      );
    }

    if (url.pathname !== "/ws") {
      return Response.json({
        service: "Kulzzy Media Control",
        status: "online",
        websocket: "/ws"
      }, { headers: cors(origin) });
    }

    if (
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("WebSocket upgrade required", {
        status: 426
      });
    }

    const id = env.MEDIA_CONTROL.idFromName(
      "kulzzy-global-playback"
    );

    return env.MEDIA_CONTROL.get(id).fetch(request);
  }
};

export class MediaControl extends DurableObject {

  async fetch(request) {

    // NEW: Diagnostic request from the Worker
    if (
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      const active = await this.ctx.storage.get("activePlayback");

      return Response.json({
        durableObject: "online",
        websocketConnections: this.ctx.getWebSockets().length,
        hasActivePlayback: Boolean(active),
        activeSource: active?.source || null
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);

    const connection = {
      source: new URL(request.url).searchParams.get("source") || "unknown",
      clientId: crypto.randomUUID()
    };

    server.serializeAttachment(connection);

    const active = await this.ctx.storage.get("activePlayback");

    server.send(JSON.stringify({
      type: "connected",
      activePlayback: active || null
    }));

    if (active) {
      server.send(JSON.stringify({
        type: "stop",
        reason: "Another Kulzzy player is already active",
        activePlayback: active
      }));
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(socket, message) {
    let data;

    try {
      data = JSON.parse(message);
    } catch {
      socket.send(JSON.stringify({
        type: "error",
        message: "Invalid message"
      }));
      return;
    }

    const connection = socket.deserializeAttachment() || {};

    if (data.type === "play") {
      const active = {
        source: connection.source,
        clientId: connection.clientId,
        playbackId: data.playbackId || crypto.randomUUID(),
        startedAt: Date.now()
      };

      await this.ctx.storage.put("activePlayback", active);

      for (const client of this.ctx.getWebSockets()) {
        if (client !== socket) {
          try {
            client.send(JSON.stringify({
              type: "stop",
              reason: "Another Kulzzy player has started",
              activePlayback: active
            }));
          } catch {}
        }
      }

      socket.send(JSON.stringify({
        type: "playback-confirmed",
        activePlayback: active
      }));

      return;
    }

    if (data.type === "stop") {
      const active = await this.ctx.storage.get("activePlayback");

      if (active?.clientId === connection.clientId) {
        await this.ctx.storage.delete("activePlayback");

        for (const client of this.ctx.getWebSockets()) {
          try {
            client.send(JSON.stringify({
              type: "playback-ended",
              source: connection.source
            }));
          } catch {}
        }
      }

      return;
    }

    if (data.type === "ping") {
      socket.send(JSON.stringify({
        type: "pong",
        time: Date.now()
      }));
    }
  }

  async webSocketClose(socket) {
    await this.release(socket);
  }

  async webSocketError(socket) {
    await this.release(socket);
  }

  async release(socket) {
    const connection = socket.deserializeAttachment() || {};
    const active = await this.ctx.storage.get("activePlayback");

    if (active?.clientId === connection.clientId) {
      await this.ctx.storage.delete("activePlayback");

      for (const client of this.ctx.getWebSockets()) {
        try {
          client.send(JSON.stringify({
            type: "playback-ended",
            source: connection.source
          }));
        } catch {}
      }
    }
  }
}
