import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v4";
import type { LinkRow } from "./db.js";
import {
  createLink,
  getLink,
  LinkActionError,
} from "./links.js";
import {
  addTrackToJam,
  closeJam,
  createJam,
  getJam,
  JAM_ACTION_ERROR_CODES,
  JamActionError,
  removeTrackFromJam,
  type JamActions,
} from "./jams.js";

const MAX_MCP_BODY_BYTES = 32 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LISTEN_HOSTS = new Set(["listen.cx", "staging.listen.cx"]);
const MCP_ERROR_CODES = [
  "invalid_track_url",
  "track_not_found",
  "provider_unavailable",
  "storage_unavailable",
  "invalid_link",
  "link_not_found",
  ...JAM_ACTION_ERROR_CODES,
  "internal_error",
] as const;

function serverInstructions(jamsEnabled: boolean): string {
  return [
    jamsEnabled
      ? "listen.cx creates single-track links and collaborative Jams, which are ordered shared queues—not synchronized playback. Use create_jam, add_track_to_jam, and get_jam for Jam requests. Keep managementToken secret."
      : "listen.cx creates single-track links. Jam tools are unavailable and are not advertised in this environment.",
    "Tracks must be direct Spotify tracks or Apple Music track deep-links; bare albums and spotify.link are unsupported.",
    "New links contain only the source-provider URL; never claim an opposite-provider URL is a verified match.",
  ].join(" ");
}

const errorDetailsSchema = z.object({
  code: z.enum(MCP_ERROR_CODES),
  status: z.number().int().min(400).max(599),
  message: z.string(),
  retryable: z.boolean(),
});

// The SDK currently advertises raw object shapes most reliably. `ok` is the
// discriminator; success-only fields and `error` are mutually exclusive in the
// values returned below even though JSON Schema cannot express that invariant.
const createOutputSchema = {
  ok: z.boolean(),
  link: z.string().url().optional(),
  slug: z.string().optional(),
  title: z.string().optional(),
  artist: z.string().optional(),
  artworkUrl: z.string().url().nullable().optional(),
  error: errorDetailsSchema.optional(),
};

const getOutputSchema = {
  ok: z.boolean(),
  slug: z.string().optional(),
  isrc: z.string().nullable().optional(),
  title: z.string().optional(),
  artist: z.string().optional(),
  artworkUrl: z.string().url().nullable().optional(),
  spotifyUrl: z.string().url().nullable().optional(),
  appleUrl: z.string().url().nullable().optional(),
  complete: z.boolean().optional(),
  createdAt: z.string().optional(),
  providerUrlStatus: z.enum(["source_only", "legacy_unverified"]).optional(),
  warning: z.string().optional(),
  error: errorDetailsSchema.optional(),
};

const createJamOutputSchema = {
  ok: z.boolean(),
  jamId: z.string().optional(),
  jamUrl: z.string().url().optional(),
  managementToken: z.string().optional(),
  title: z.string().optional(),
  state: z.literal("open").optional(),
  createdAt: z.string().optional(),
  error: errorDetailsSchema.optional(),
};

const jamTrackSchema = z.object({
  contributionId: z.number().int().positive(),
  position: z.number().int().positive(),
  listenLink: z.string().url(),
  title: z.string(),
  artist: z.string(),
  artworkUrl: z.string().url().nullable(),
});

const getJamOutputSchema = {
  ok: z.boolean(),
  jamId: z.string().optional(),
  jamUrl: z.string().url().optional(),
  title: z.string().optional(),
  state: z.enum(["open", "closed"]).optional(),
  createdAt: z.string().optional(),
  closedAt: z.string().nullable().optional(),
  activeTrackCount: z.number().int().nonnegative().optional(),
  totalContributions: z.number().int().nonnegative().optional(),
  contributionLimit: z.number().int().positive().optional(),
  tracks: z.array(jamTrackSchema).optional(),
  error: errorDetailsSchema.optional(),
};

const addJamTrackOutputSchema = {
  ok: z.boolean(),
  status: z.enum(["accepted", "existing"]).optional(),
  jamId: z.string().optional(),
  requestKey: z.string().optional(),
  contributionId: z.number().int().positive().optional(),
  position: z.number().int().positive().optional(),
  listenLink: z.string().url().optional(),
  error: errorDetailsSchema.optional(),
};

const removeJamTrackOutputSchema = {
  ok: z.boolean(),
  status: z.literal("removed").optional(),
  jamId: z.string().optional(),
  contributionId: z.number().int().positive().optional(),
  position: z.number().int().positive().optional(),
  error: errorDetailsSchema.optional(),
};

const closeJamOutputSchema = {
  ok: z.boolean(),
  status: z.literal("closed").optional(),
  jamId: z.string().optional(),
  closedAt: z.string().nullable().optional(),
  error: errorDetailsSchema.optional(),
};

function toolError(error: unknown) {
  const details = error instanceof LinkActionError || error instanceof JamActionError
    ? {
        code: error.code,
        status: error.status,
        message: error.message,
        retryable: error.retryable,
      }
    : {
        code: "internal_error" as const,
        status: 500,
        message: "Internal server error.",
        retryable: true,
      };

  return {
    isError: true as const,
    content: [{ type: "text" as const, text: details.message }],
    structuredContent: { ok: false as const, error: details },
  };
}

function normalizeRow(row: LinkRow) {
  const legacyUnverified = row.complete === 1 || Boolean(row.spotify_url && row.apple_url);
  return {
    ok: true as const,
    slug: row.slug,
    isrc: row.isrc,
    title: row.title,
    artist: row.artist,
    artworkUrl: row.artwork_url,
    spotifyUrl: row.spotify_url,
    appleUrl: row.apple_url,
    complete: row.complete === 1,
    createdAt: row.created_at,
    providerUrlStatus: legacyUnverified ? "legacy_unverified" as const : "source_only" as const,
    warning: legacyUnverified
      ? "This legacy row may contain an inferred cross-provider URL. Do not describe its provider URLs as a verified match."
      : "Only the submitted provider URL is stored; no cross-provider match was attempted or verified.",
  };
}

function jsonRpcHttpError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: { code, message },
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isAllowedMcpHost(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname)
    || LISTEN_HOSTS.has(url.hostname);
}

function isAllowedMcpOrigin(origin: string, requestUrl: URL): boolean {
  try {
    return new URL(origin).origin === requestUrl.origin;
  } catch {
    return false;
  }
}

async function readMcpBody(request: Request): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const rawContentLength = request.headers.get("content-length");
  if (rawContentLength !== null) {
    const contentLength = Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return { ok: false, response: jsonRpcHttpError(400, -32600, "Invalid Content-Length.") };
    }
    if (contentLength > MAX_MCP_BODY_BYTES) {
      return { ok: false, response: jsonRpcHttpError(413, -32000, "MCP request body is too large.") };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, response: jsonRpcHttpError(400, -32700, "Missing JSON request body.") };
  }

  const chunks: Uint8Array[] = [];
  let bodySize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bodySize += value.byteLength;
      if (bodySize > MAX_MCP_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {}
        return { ok: false, response: jsonRpcHttpError(413, -32000, "MCP request body is too large.") };
      }
      chunks.push(value);
    }

    const body = new Uint8Array(bodySize);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {
        ok: false,
        response: jsonRpcHttpError(400, -32600, "Send one JSON-RPC message per request."),
      };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: jsonRpcHttpError(400, -32700, "Invalid JSON request body.") };
  }
}

export function createListenMcpServer(actions: JamActions): McpServer {
  const server = new McpServer(
    { name: "listen-cx", version: "0.2.0" },
    { instructions: serverInstructions(actions.jamsEnabled) },
  );

  server.registerTool(
    "create_listen_link",
    {
      title: "Create listen.cx link",
      description: [
        "Create an immutable listen.cx share link from one direct Spotify track or Apple Music track deep-link.",
        "An Apple album URL is accepted only when it has a track ?i= parameter.",
        "Each call creates a new link.",
        ...(actions.jamsEnabled
          ? ["Use create_jam and add_track_to_jam instead when the user wants a collaborative queue."]
          : []),
        "Bare albums, spotify.link redirects, provider preferences, and cross-provider matching are not supported.",
      ].join(" "),
      inputSchema: {
        url: z.string().min(1).max(4096).describe("Spotify or Apple Music track URL"),
      },
      outputSchema: createOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url }) => {
      try {
        const link = await createLink(actions, url);
        return {
          content: [{
            type: "text",
            text: `Created “${link.title}” by ${link.artist}: ${link.link}`,
          }],
          structuredContent: { ok: true, ...link },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_listen_link",
    {
      title: "Get listen.cx link",
      description: [
        "Retrieve stored metadata for a listen.cx link by slug or same-server URL.",
        "Always inspect providerUrlStatus and warning; provider URLs in legacy rows are not verified matches.",
      ].join(" "),
      inputSchema: {
        slugOrUrl: z.string().min(1).max(4096).describe("Seven-character slug or listen.cx URL"),
      },
      outputSchema: getOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ slugOrUrl }) => {
      try {
        const link = normalizeRow(await getLink(actions.store, slugOrUrl, actions.baseUrl));
        return {
          content: [{ type: "text", text: `“${link.title}” by ${link.artist}.` }],
          structuredContent: link,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  if (actions.jamsEnabled) {
    server.registerTool(
    "create_jam",
    {
      title: "Create collaborative Jam",
      description: [
        "Create a real collaborative listen.cx Jam: an ordered queue that other callers can add tracks to.",
        "This does not start synchronized playback.",
        "The result includes a public jamId and a secret managementToken returned only at creation; keep the token private.",
      ].join(" "),
      inputSchema: {
        title: z.string().min(1).max(80).describe("Human-readable Jam title"),
      },
      outputSchema: createJamOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ title }) => {
      try {
        const jam = await createJam(actions, title);
        return {
          content: [{
            type: "text",
            text: `Created Jam “${jam.title}” (${jam.jamId}). Keep its managementToken secret.`,
          }],
          structuredContent: { ok: true, ...jam },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

    server.registerTool(
    "get_jam",
    {
      title: "Get collaborative Jam",
      description: "Read a Jam's state and active ordered track queue using its public Jam id.",
      inputSchema: {
        jamId: z.string().min(1).max(128).describe("Public Jam id returned by create_jam"),
      },
      outputSchema: getJamOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ jamId }) => {
      try {
        const jam = await getJam(actions, jamId);
        return {
          content: [{
            type: "text",
            text: `Jam “${jam.title}” is ${jam.state} with ${jam.activeTrackCount} active track${jam.activeTrackCount === 1 ? "" : "s"}.`,
          }],
          structuredContent: { ok: true, ...jam },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

    server.registerTool(
    "add_track_to_jam",
    {
      title: "Add track to Jam",
      description: [
        "Resolve one direct Spotify or Apple Music track URL and append it to a Jam's ordered queue.",
        "Supply a stable requestKey and reuse it if the same operation is retried; reusing it with another track is rejected.",
      ].join(" "),
      inputSchema: {
        jamId: z.string().min(1).max(128).describe("Public Jam id"),
        url: z.string().min(1).max(4096).describe("Direct Spotify or Apple Music track URL"),
        requestKey: z.string().min(1).max(128).describe("Caller-generated idempotency key"),
      },
      outputSchema: addJamTrackOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ jamId, url, requestKey }) => {
      try {
        const result = await addTrackToJam(actions, jamId, url, requestKey);
        return {
          content: [{
            type: "text",
            text: `${result.status === "accepted" ? "Added" : "Already added"} track at position ${result.position}: ${result.listenLink}`,
          }],
          structuredContent: { ok: true, ...result },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

    server.registerTool(
    "remove_track_from_jam",
    {
      title: "Remove track from Jam",
      description: [
        "Remove one active Jam contribution using the secret managementToken returned by create_jam.",
        "The removal is idempotent and preserves queue history.",
      ].join(" "),
      inputSchema: {
        jamId: z.string().min(1).max(128).describe("Public Jam id"),
        managementToken: z.string().min(1).max(128).describe("Secret Jam management token"),
        contributionId: z.number().int().positive().describe("Contribution id returned by add_track_to_jam or get_jam"),
      },
      outputSchema: removeJamTrackOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ jamId, managementToken, contributionId }) => {
      try {
        const result = await removeTrackFromJam(
          actions,
          jamId,
          managementToken,
          contributionId,
        );
        return {
          content: [{ type: "text", text: `Removed Jam track at position ${result.position}.` }],
          structuredContent: { ok: true, ...result },
        };
      } catch (error) {
        return toolError(error);
      }
    },
    );

    server.registerTool(
    "close_jam",
    {
      title: "Close Jam",
      description: [
        "Permanently close a Jam to new tracks using its secret managementToken.",
        "Existing tracks remain readable and closing an already closed Jam is safe.",
      ].join(" "),
      inputSchema: {
        jamId: z.string().min(1).max(128).describe("Public Jam id"),
        managementToken: z.string().min(1).max(128).describe("Secret Jam management token"),
      },
      outputSchema: closeJamOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ jamId, managementToken }) => {
      try {
        const result = await closeJam(actions, jamId, managementToken);
        return {
          content: [{ type: "text", text: `Closed Jam ${result.jamId}.` }],
          structuredContent: { ok: true, ...result },
        };
      } catch (error) {
        return toolError(error);
      }
    },
    );
  }

  server.registerTool(
    "check_listen_health",
    {
      title: "Check listen.cx health",
      description: "Check whether the listen.cx link store is available.",
      inputSchema: {},
      outputSchema: {
        status: z.enum(["ok", "unavailable"]),
        baseUrl: z.string().url(),
        links: z.enum(["ok", "unavailable"]),
        jams: z.enum(["ok", "unavailable", "disabled"]),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const [linksReady, jamsReady] = await Promise.all([
          actions.store.isReady(),
          actions.jamsEnabled ? actions.jamStore.isReady() : Promise.resolve(true),
        ]);
        const result = {
          status: linksReady && jamsReady ? "ok" as const : "unavailable" as const,
          baseUrl: actions.baseUrl,
          links: linksReady ? "ok" as const : "unavailable" as const,
          jams: actions.jamsEnabled
            ? (jamsReady ? "ok" as const : "unavailable" as const)
            : "disabled" as const,
        };
        return {
          content: [{ type: "text", text: `listen.cx is ${result.status}.` }],
          structuredContent: result,
          isError: result.status !== "ok",
        };
      } catch {
        return {
          content: [{ type: "text", text: "listen.cx is unavailable." }],
          structuredContent: {
            status: "unavailable",
            baseUrl: actions.baseUrl,
            links: "unavailable",
            jams: actions.jamsEnabled ? "unavailable" : "disabled",
          },
          isError: true,
        };
      }
    },
  );

  return server;
}

export async function handleMcpRequest(request: Request, actions: JamActions): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (!isAllowedMcpHost(requestUrl)) {
    return jsonRpcHttpError(403, -32000, "MCP host is not allowed.");
  }

  const host = request.headers.get("host");
  if (host && host.toLowerCase() !== requestUrl.host.toLowerCase()) {
    return jsonRpcHttpError(403, -32000, "MCP Host header does not match the request URL.");
  }

  const origin = request.headers.get("origin");
  if (origin && !isAllowedMcpOrigin(origin, requestUrl)) {
    return jsonRpcHttpError(403, -32000, "MCP origin is not allowed.");
  }

  if (request.method === "OPTIONS") {
    const headers = new Headers({
      Allow: "POST, OPTIONS",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, mcp-protocol-version",
      Vary: "Origin",
    });
    if (origin) headers.set("Access-Control-Allow-Origin", origin);
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } });
  }

  const body = await readMcpBody(request);
  if (!body.ok) return body.response;

  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  const server = createListenMcpServer(actions);
  await server.connect(transport);
  const response = await transport.handleRequest(request, { parsedBody: body.value });
  if (!origin) return response;

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
