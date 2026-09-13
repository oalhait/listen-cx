import { env } from "cloudflare:workers";
import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { D1LinkStore } from "./db.js";
import type { Resolved } from "./resolve.js";
import { D1ThreadCollaborationStore } from "./thread-collaboration-db.js";
import { ThreadCollaborationService } from "./thread-collaboration-service.js";
import { THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT } from "./thread-collaboration.js";
import { D1ThreadStore } from "./thread-db.js";

const baseUrl = "https://listen.test";
const source = {
  provider: "spotify" as const,
  id: "4SN5Kkig8iJ8vdwsOoP7IO",
  storefront: "us",
};
const track: Resolved = {
  title: "Cataracts",
  artist: "Freddie Gibbs, Madlib",
  artworkUrl: null,
  spotifyUrl: `https://open.spotify.com/track/${source.id}`,
  appleUrl: null,
  isrc: null,
  complete: false,
};
const resolve = vi.fn<(_: string) => Promise<Resolved | null>>();
const threads = new D1ThreadStore(env.DB);
const social = new D1ThreadCollaborationStore(env.DB);
const app = createApp({
  resolver: { resolve },
  store: new D1LinkStore(env.DB),
  threadStore: threads,
  collaboration: new ThreadCollaborationService(social),
  baseUrl,
});

function post(path: string, body: unknown, cookie = "") {
  return app.request(baseUrl + path, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
      "X-Listen-Action": "thread",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function cookie(response: Response, name: string): string {
  const value = response.headers.getSetCookie().find(item => item.startsWith(`${name}=`));
  if (!value) throw new Error(`Missing ${name} cookie`);
  return value.split(";", 1)[0]!;
}

async function room() {
  const managementCapability = nanoid(22);
  const created = await post("/api/threads", { title: "Friends pick", creationKey: managementCapability });
  const body = await created.json() as { thread: { publicCapability: string } };
  const capability = body.thread.publicCapability;
  await threads.add(capability, {
    source,
    track,
    expectedRevision: 0,
    requestKey: nanoid(),
  });
  return {
    capability,
    contributionId: (await threads.get(capability))!.contributions[0]!.id,
    managementCookie: cookie(created, `thread_manage_${capability}`),
  };
}

async function join(capability: string, displayName: string) {
  const response = await post(`/api/threads/${capability}/collaboration/join`, { displayName });
  expect(response.status).toBe(200);
  const participantCookie = cookie(response, "listen_jam_participant");
  const body = await response.json() as { collaboration: { viewer: { joined: boolean; displayName: string } } };
  expect(body.collaboration.viewer).toMatchObject({ joined: true, displayName });
  return participantCookie;
}

beforeEach(() => resolve.mockReset().mockResolvedValue(track));

describe("Jam collaboration HTTP contract", () => {
  it("attributes a joined friend's song and rejects cross-participant request-key reuse", async () => {
    const { capability } = await room();
    const alice = await join(capability, "Alice");
    const bob = await join(capability, "Bob");
    const snapshot = await app.request(`${baseUrl}/api/threads/${capability}/collaboration`, {
      headers: { Cookie: alice },
    });
    const participantId = (await snapshot.json() as {
      viewer: { participant: { id: string } };
    }).viewer.participant.id;

    const added = await post(`/api/threads/${capability}/contributions`, {
      url: track.spotifyUrl,
      requestKey: "friend-add",
      expectedRevision: 1,
    }, alice);
    expect(added.status).toBe(200);
    const payload = await added.json() as {
      thread: { revision: number; contributions: Array<{ addedBy: unknown }> };
    };
    expect(payload.thread).toMatchObject({
      revision: 2,
      contributions: [
        { addedBy: null },
        { addedBy: { participantId, displayName: "Alice", avatarUrl: null } },
      ],
    });

    const conflict = await post(`/api/threads/${capability}/contributions`, {
      url: track.spotifyUrl,
      requestKey: "friend-add",
      expectedRevision: 2,
    }, bob);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "request_conflict" });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect((await threads.get(capability))!.revision).toBe(2);

    const serialized = JSON.stringify(payload);
    const token = alice.split("=", 2)[1]!;
    const digest = await env.DB.prepare(`SELECT anonymous_digest
      FROM thread_collaboration_participants participant
      JOIN threads thread ON thread.id = participant.thread_id
      WHERE thread.public_capability = ? AND participant.public_id = ?`)
      .bind(capability, participantId).first<string>("anonymous_digest");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(digest!);
    expect(serialized).not.toContain("anonymous_digest");
  });

  it("lets two private browser participants chat and vote without changing playlist revision", async () => {
    const { capability, contributionId } = await room();
    const alice = await join(capability, "Alice");
    const bob = await join(capability, "Bob");

    const aliceMessage = await post(`/api/threads/${capability}/messages`, {
      text: "This one should open the Jam.",
      requestKey: "alice-message",
    }, alice);
    expect(aliceMessage.status).toBe(200);
    expect((await aliceMessage.json() as { collaboration: { messages: unknown[] } }).collaboration.messages).toHaveLength(1);
    expect((await post(`/api/threads/${capability}/messages`, {
      text: "This one should open the Jam.",
      requestKey: "alice-message",
    }, alice)).status).toBe(200);

    expect((await post(`/api/threads/${capability}/votes`, {
      contributionId,
      vote: "up",
      requestKey: "alice-up",
    }, alice)).status).toBe(200);
    expect((await post(`/api/threads/${capability}/votes`, {
      contributionId,
      vote: "down",
      requestKey: "bob-down",
    }, bob)).status).toBe(200);
    expect((await post(`/api/threads/${capability}/messages`, {
      text: "I vote for the next track.",
      requestKey: "bob-message",
    }, bob)).status).toBe(200);

    const response = await app.request(`${baseUrl}/api/threads/${capability}/collaboration`, {
      headers: { Cookie: alice },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("ETag")).toMatch(/^"[a-f0-9]{64}"$/);
    const snapshot = await response.json() as Record<string, any>;
    expect(snapshot).toMatchObject({
      participantCount: 2,
      viewer: { joined: true, signedIn: false, displayName: "Alice" },
      votes: [{ contributionId, upvotes: 1, downvotes: 1, score: 0, myVote: "up" }],
      messages: [
        { text: "This one should open the Jam.", author: { displayName: "Alice" }, deleted: false },
        { text: "I vote for the next track.", author: { displayName: "Bob" }, deleted: false },
      ],
    });
    expect(await (await app.request(`${baseUrl}/api/threads/${capability}/collaboration`, {
      headers: { Cookie: alice, "If-None-Match": response.headers.get("ETag")! },
    })).text()).toBe("");
    expect((await threads.get(capability))!.revision).toBe(1);

    const serialized = JSON.stringify(snapshot);
    const rawToken = alice.split("=", 2)[1]!;
    expect(serialized).not.toContain(rawToken);
    const stored = await env.DB.prepare(`SELECT anonymous_digest FROM thread_collaboration_participants p
      JOIN threads t ON t.id = p.thread_id WHERE t.public_capability = ? AND p.display_name = 'Alice'`)
      .bind(capability).first<string>("anonymous_digest");
    expect(stored).toMatch(/^[a-f0-9]{64}$/);
    expect(stored).not.toBe(rawToken);
  });

  it("returns a bounded error without changing votes when a participant exhausts vote receipts", async () => {
    const { capability, contributionId } = await room();
    const participantCookie = await join(capability, "Receipt limit");
    const participant = await env.DB.prepare(`SELECT participant.id, participant.thread_id
      FROM thread_collaboration_participants participant
      JOIN threads thread ON thread.id = participant.thread_id
      WHERE thread.public_capability = ? AND participant.display_name = 'Receipt limit'`)
      .bind(capability).first<{ id: number; thread_id: number }>();
    if (!participant) throw new Error("Participant missing");
    await env.DB.prepare(`WITH RECURSIVE sequence(value) AS (
        VALUES(0) UNION ALL SELECT value + 1 FROM sequence WHERE value + 1 < ?
      )
      INSERT INTO thread_collaboration_vote_requests
        (thread_id, participant_id, request_key, contribution_id, vote, mutation_token)
      SELECT ?, ?, 'http-limit-request-' || value, ?, 'up', 'http-limit-token-' || value
      FROM sequence`)
      .bind(
        THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT,
        participant.thread_id,
        participant.id,
        contributionId,
      ).run();
    const revisionBefore = await env.DB.prepare(`SELECT revision FROM thread_collaboration_state
      WHERE thread_id = ?`).bind(participant.thread_id).first<number>("revision");

    const response = await post(`/api/threads/${capability}/votes`, {
      contributionId,
      vote: "down",
      requestKey: "http-over-participant-limit",
    }, participantCookie);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "participant_vote_request_limit",
      error: "This participant has reached the Jam vote-change limit.",
    });
    expect((await env.DB.prepare(`SELECT COUNT(*) AS count
      FROM thread_collaboration_vote_requests WHERE participant_id = ?`)
      .bind(participant.id).first<{ count: number }>())?.count)
      .toBe(THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS count
      FROM thread_collaboration_votes WHERE participant_id = ?`)
      .bind(participant.id).first<{ count: number }>())?.count).toBe(0);
    expect(await env.DB.prepare(`SELECT revision FROM thread_collaboration_state
      WHERE thread_id = ?`).bind(participant.thread_id).first<number>("revision"))
      .toBe(revisionBefore);
  });

  it("requires same-origin controls and a joined identity, freezes writes on close, and retains moderation", async () => {
    const { capability, contributionId, managementCookie } = await room();
    const page = await app.request(`${baseUrl}/t/${capability}`);
    expect(page.status).toBe(200);
    expect(cookie(page, "listen_jam_participant")).toMatch(/^listen_jam_participant=[A-Za-z0-9_-]{43}$/);
    expect((await post(`/api/threads/${capability}/messages`, {
      text: "Not joined",
      requestKey: "not-joined",
    })).status).toBe(401);
    const hostile = await app.request(`${baseUrl}/api/threads/${capability}/collaboration/join`, {
      method: "POST",
      headers: { Origin: "https://attacker.test", "Content-Type": "application/json", "X-Listen-Action": "thread" },
      body: JSON.stringify({ displayName: "Mallory" }),
    });
    expect(hostile.status).toBe(403);

    const friend = await join(capability, "Casey");
    const posted = await post(`/api/threads/${capability}/messages`, {
      text: "Keep the history, even when closed.",
      requestKey: "history",
    }, friend);
    const messageId = (await posted.json() as { message: { id: number } }).message.id;
    expect((await post(`/t/${capability}/manage/messages`, {
      messageId,
      requestKey: "unauthorized-moderation",
    })).status).toBe(403);

    const closed = await post(`/t/${capability}/manage/mutate`, {
      kind: "close",
      expectedRevision: 1,
      requestKey: "close-jam",
    }, managementCookie);
    expect(closed.status).toBe(200);
    expect((await post(`/api/threads/${capability}/messages`, {
      text: "Too late",
      requestKey: "after-close-message",
    }, friend)).status).toBe(409);
    expect((await post(`/api/threads/${capability}/votes`, {
      contributionId,
      vote: "up",
      requestKey: "after-close-vote",
    }, friend)).status).toBe(409);

    const moderated = await post(`/t/${capability}/manage/messages`, {
      messageId,
      requestKey: "moderate-after-close",
    }, managementCookie);
    expect(moderated.status).toBe(200);
    expect(await moderated.json()).toMatchObject({
      status: "removed",
      collaboration: { closed: true, messages: [{ id: messageId, text: "", deleted: true }] },
    });
    expect((await app.request(`${baseUrl}/api/threads/${capability}/collaboration`)).status).toBe(200);
  });
});
