import { env } from "cloudflare:workers";
import { nanoid } from "nanoid";
import { describe, expect, it } from "vitest";
import { D1AccountStore } from "./account-db.js";
import { D1ProfileStore } from "./profile-db.js";
import type { Resolved } from "./resolve.js";
import { D1ThreadCollaborationStore } from "./thread-collaboration-db.js";
import {
  THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT,
  THREAD_VOTE_REQUESTS_PER_THREAD_LIMIT,
  type CollaborationIdentity,
} from "./thread-collaboration.js";
import { D1ThreadStore } from "./thread-db.js";
import { authorizeManagementCapability } from "./thread-security.js";
import { sha256 } from "./thread.js";

const threads = new D1ThreadStore(env.DB);
const collaboration = new D1ThreadCollaborationStore(env.DB);
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

async function anonymous(label = nanoid()): Promise<CollaborationIdentity> {
  return { kind: "anonymous", digest: await sha256(label) };
}

async function setup(title = "Friends") {
  const managementCapability = nanoid(22);
  const thread = await threads.create(title, managementCapability);
  const authorization = await authorizeManagementCapability(
    threads,
    thread.publicCapability,
    managementCapability,
  );
  if (!authorization) throw new Error("Management authorization failed");
  return { thread, authorization };
}

async function addSong(capability: string, revision = 0) {
  await threads.add(capability, {
    expectedRevision: revision,
    requestKey: nanoid(),
    source,
    track,
  });
  return (await threads.get(capability))!.contributions[0]!;
}

async function storedParticipant(capability: string, publicId: string) {
  const participant = await env.DB.prepare(`SELECT participant.id, participant.thread_id
    FROM thread_collaboration_participants participant
    JOIN threads thread ON thread.id = participant.thread_id
    WHERE thread.public_capability = ? AND participant.public_id = ?`)
    .bind(capability, publicId)
    .first<{ id: number; thread_id: number }>();
  if (!participant) throw new Error("Stored participant missing");
  return participant;
}

async function seedVoteRequests(
  threadId: number,
  participantId: number,
  contributionId: number,
  count: number,
  prefix: string,
): Promise<void> {
  if (count < 1) return;
  await env.DB.prepare(`WITH RECURSIVE sequence(value) AS (
      VALUES(0) UNION ALL SELECT value + 1 FROM sequence WHERE value + 1 < ?
    )
    INSERT INTO thread_collaboration_vote_requests
      (thread_id, participant_id, request_key, contribution_id, vote, mutation_token)
    SELECT ?, ?, ? || value, ?, 'up', ? || value FROM sequence`)
    .bind(count, threadId, participantId, `${prefix}-request-`, contributionId, `${prefix}-token-`)
    .run();
}

describe("D1ThreadCollaborationStore participants and messages", () => {
  it("reports collaboration schema readiness", async () => {
    await expect(collaboration.isReady()).resolves.toBe(true);
  });

  it.each([
    { collaboration_tables: 4, attribution_columns: 1, vote_limit_triggers: 2 },
    { collaboration_tables: 5, attribution_columns: 0, vote_limit_triggers: 2 },
    { collaboration_tables: 5, attribution_columns: 1, vote_limit_triggers: 1 },
  ])("rejects an incomplete collaboration schema %#", async (readiness) => {
    const incomplete = new D1ThreadCollaborationStore({
      prepare: () => ({ first: async () => readiness }),
    } as unknown as D1Database);
    await expect(incomplete.isReady()).resolves.toBe(false);
  });

  it("enforces participant and message boundaries and requires joining", async () => {
    const { thread } = await setup();
    const identity = await anonymous();
    await expect(collaboration.join(thread.publicCapability, identity, " "))
      .rejects.toMatchObject({ code: "invalid_participant" });
    await expect(collaboration.join(thread.publicCapability, identity, "x".repeat(41)))
      .rejects.toMatchObject({ code: "invalid_participant" });
    await expect(collaboration.postMessage(thread.publicCapability, identity, {
      text: "Not joined",
      requestKey: "not-joined",
    })).rejects.toMatchObject({ code: "join_required", status: 401 });
    await collaboration.join(thread.publicCapability, identity, "Alex");
    await expect(collaboration.postMessage(thread.publicCapability, identity, {
      text: " ",
      requestKey: "empty",
    })).rejects.toMatchObject({ code: "invalid_message" });
    await expect(collaboration.postMessage(thread.publicCapability, identity, {
      text: "x".repeat(501),
      requestKey: "long",
    })).rejects.toMatchObject({ code: "invalid_message" });
  });

  it("joins digest-backed and account-backed participants without exposing private identities", async () => {
    const { thread } = await setup();
    const browser = await anonymous("browser-private-capability");
    const accounts = new D1AccountStore(env.DB);
    const account = await accounts.upsert("spotify", `subject-${nanoid()}`, "Provider label");
    await new D1ProfileStore(env.DB).seed(account.id, {
      displayName: "Provider profile",
      avatarUrl: "https://images.example/friend.png",
    });

    const guest = await collaboration.join(thread.publicCapability, browser, "  Ari  ");
    const member = await collaboration.join(
      thread.publicCapability,
      { kind: "account", accountId: account.id },
      "Bea",
    );
    const rejoined = await collaboration.join(thread.publicCapability, browser, "Ari");
    const snapshot = await collaboration.snapshot(thread.publicCapability, {
      kind: "account",
      accountId: account.id,
    });

    expect(guest).toMatchObject({ created: true, participant: { displayName: "Ari", avatarUrl: null } });
    expect(member).toMatchObject({
      created: true,
      participant: { displayName: "Bea", avatarUrl: "https://images.example/friend.png" },
    });
    expect(rejoined).toMatchObject({ created: false, participant: guest.participant });
    expect(snapshot).toMatchObject({
      participantCount: 2,
      viewer: {
        joined: true,
        signedIn: true,
        displayName: "Bea",
        avatarUrl: "https://images.example/friend.png",
      },
      limits: { messageLength: 500 },
    });
    const serialized = JSON.stringify({ guest, member, snapshot });
    expect(serialized).not.toContain("browser-private-capability");
    expect(serialized).not.toContain(account.id);
    expect(serialized).not.toContain(account.subject);
    expect(serialized).not.toContain("anonymous_digest");
    expect(serialized).not.toContain("account_id");
  });

  it("uses one participant for linked Spotify and Apple accounts", async () => {
    const { thread } = await setup();
    const accounts = new D1AccountStore(env.DB);
    const spotify = await accounts.upsert("spotify", `spotify-${nanoid()}`, "Spotify");
    const apple = await accounts.upsert("apple", `apple-${nanoid()}`, "Apple");
    const profiles = new D1ProfileStore(env.DB);
    await profiles.seed(spotify.id, { displayName: "Casey", avatarUrl: null });
    await profiles.seed(apple.id, { displayName: "Casey", avatarUrl: null });
    await env.DB.prepare("UPDATE accounts SET group_id = ? WHERE id = ?")
      .bind(spotify.groupId, apple.id)
      .run();

    const first = await collaboration.join(
      thread.publicCapability,
      { kind: "account", accountId: spotify.id },
      "Casey",
    );
    const second = await collaboration.join(
      thread.publicCapability,
      { kind: "account", accountId: apple.id },
      "Casey",
    );

    expect(second).toEqual({ participant: first.participant, created: false });
    expect((await collaboration.snapshot(thread.publicCapability))?.participantCount).toBe(1);
  });

  it("posts plain-text messages idempotently and advances only collaboration revision", async () => {
    const { thread } = await setup();
    const identity = await anonymous();
    await collaboration.join(thread.publicCapability, identity, "Devon");
    const revisionAfterJoin = (await collaboration.snapshot(thread.publicCapability, identity))!
      .collaborationRevision;

    const first = await collaboration.postMessage(thread.publicCapability, identity, {
      text: "  Keep this <b>plain</b>\r\nplease  ",
      requestKey: "message-1",
    });
    const replay = await collaboration.postMessage(thread.publicCapability, identity, {
      text: "Keep this <b>plain</b>\nplease",
      requestKey: "message-1",
    });
    await expect(collaboration.postMessage(thread.publicCapability, identity, {
      text: "Different",
      requestKey: "message-1",
    })).rejects.toMatchObject({ code: "request_conflict" });
    const snapshot = await collaboration.snapshot(thread.publicCapability, identity);

    expect(first).toMatchObject({ replayed: false, message: { text: "Keep this <b>plain</b>\nplease" } });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(snapshot).toMatchObject({
      collaborationRevision: revisionAfterJoin + 1,
      messages: [{
        id: first.message.id,
        author: first.message.author,
        text: "Keep this <b>plain</b>\nplease",
        deleted: false,
      }],
    });
    expect((await threads.get(thread.publicCapability))?.revision).toBe(0);
  });

  it("returns stable newest-first initialization and ascending cursor pages", async () => {
    const { thread } = await setup();
    const identity = await anonymous();
    await collaboration.join(thread.publicCapability, identity, "Dana");
    const ids: number[] = [];
    for (const [index, text] of ["one", "two", "three"].entries()) {
      const result = await collaboration.postMessage(thread.publicCapability, identity, {
        text,
        requestKey: `page-${index}`,
      });
      ids.push(result.message.id);
    }

    const initial = await collaboration.snapshot(thread.publicCapability, identity, { limit: 2 });
    expect(initial).toMatchObject({
      messages: [{ id: ids[1], text: "two" }, { id: ids[2], text: "three" }],
      messageCursor: ids[2],
      hasMoreMessages: true,
    });
    const firstDelta = await collaboration.snapshot(thread.publicCapability, identity, {
      afterMessageId: ids[0],
      limit: 1,
    });
    expect(firstDelta).toMatchObject({
      messages: [{ id: ids[1], text: "two" }],
      messageCursor: ids[1],
      hasMoreMessages: true,
    });
    const secondDelta = await collaboration.snapshot(thread.publicCapability, identity, {
      afterMessageId: firstDelta!.messageCursor,
      limit: 2,
    });
    expect(secondDelta).toMatchObject({
      messages: [{ id: ids[2], text: "three" }],
      messageCursor: ids[2],
      hasMoreMessages: false,
    });
  });

  it("enforces the 2,000-message lifetime limit atomically", async () => {
    const { thread } = await setup();
    const identity = await anonymous();
    await collaboration.join(thread.publicCapability, identity, "Ellis");
    const participant = await env.DB.prepare(`SELECT p.id, p.thread_id FROM thread_collaboration_participants p
      JOIN threads t ON t.id = p.thread_id WHERE t.public_capability = ?`)
      .bind(thread.publicCapability)
      .first<{ id: number; thread_id: number }>();
    if (!participant) throw new Error("Participant missing");
    await env.DB.prepare(`WITH RECURSIVE sequence(value) AS (
        VALUES(0) UNION ALL SELECT value + 1 FROM sequence WHERE value < 1998
      )
      INSERT INTO thread_collaboration_messages(thread_id, participant_id, request_key, body)
      SELECT ?, ?, 'seed-' || value, 'seed' FROM sequence`)
      .bind(participant.thread_id, participant.id)
      .run();

    const results = await Promise.allSettled([
      collaboration.postMessage(thread.publicCapability, identity, { text: "Last A", requestKey: "last-a" }),
      collaboration.postMessage(thread.publicCapability, identity, { text: "Last B", requestKey: "last-b" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "message_limit" },
    });
    const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM thread_collaboration_messages
      WHERE thread_id = ?`).bind(participant.thread_id).first<{ count: number }>();
    expect(count?.count).toBe(2_000);
  });
});

describe("D1ThreadCollaborationStore votes and moderation", () => {
  it("sets advisory up/down votes, replays requests, and clears without changing song order", async () => {
    const { thread } = await setup();
    const song = await addSong(thread.publicCapability);
    const firstIdentity = await anonymous();
    const secondIdentity = await anonymous();
    await collaboration.join(thread.publicCapability, firstIdentity, "Fin");
    await collaboration.join(thread.publicCapability, secondIdentity, "Gray");
    const threadRevision = (await threads.get(thread.publicCapability))!.revision;

    expect(await collaboration.setVote(thread.publicCapability, firstIdentity, {
      contributionId: song.id, vote: "up", requestKey: "first-up",
    })).toMatchObject({ vote: { contributionId: song.id, myVote: "up" }, replayed: false });
    expect(await collaboration.setVote(thread.publicCapability, secondIdentity, {
      contributionId: song.id, vote: "down", requestKey: "second-down",
    })).toMatchObject({ vote: { contributionId: song.id, myVote: "down" }, replayed: false });
    expect(await collaboration.setVote(thread.publicCapability, firstIdentity, {
      contributionId: song.id, vote: "up", requestKey: "first-up",
    })).toMatchObject({ vote: { contributionId: song.id, myVote: "up" }, replayed: true });
    await expect(collaboration.setVote(thread.publicCapability, firstIdentity, {
      contributionId: song.id, vote: "down", requestKey: "first-up",
    })).rejects.toMatchObject({ code: "request_conflict" });

    expect((await collaboration.snapshot(thread.publicCapability, firstIdentity))?.votes).toEqual([{
      contributionId: song.id,
      upvotes: 1,
      downvotes: 1,
      score: 0,
      myVote: "up",
    }]);
    expect(await collaboration.setVote(thread.publicCapability, firstIdentity, {
      contributionId: song.id, vote: "clear", requestKey: "first-clear",
    })).toMatchObject({ vote: { contributionId: song.id, myVote: null }, replayed: false });
    expect(await collaboration.setVote(thread.publicCapability, firstIdentity, {
      contributionId: song.id, vote: "clear", requestKey: "first-clear",
    })).toMatchObject({ vote: { contributionId: song.id, myVote: null }, replayed: true });
    expect((await collaboration.snapshot(thread.publicCapability, firstIdentity))?.votes[0]).toEqual({
      contributionId: song.id,
      upvotes: 0,
      downvotes: 1,
      score: -1,
      myVote: null,
    });
    expect((await threads.get(thread.publicCapability))!.revision).toBe(threadRevision);
  });

  it("atomically enforces the per-participant vote-receipt cap under concurrent requests", async () => {
    const { thread } = await setup();
    const song = await addSong(thread.publicCapability);
    const identity = await anonymous();
    const joined = await collaboration.join(thread.publicCapability, identity, "Limit tester");
    const participant = await storedParticipant(thread.publicCapability, joined.participant.id);
    await seedVoteRequests(
      participant.thread_id,
      participant.id,
      song.id,
      THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT - 1,
      `participant-${joined.participant.id}`,
    );
    const before = (await collaboration.snapshot(thread.publicCapability, identity))!;
    const requests = [
      { contributionId: song.id, vote: "up" as const, requestKey: "participant-limit-up" },
      { contributionId: song.id, vote: "down" as const, requestKey: "participant-limit-down" },
    ];

    const results = await Promise.allSettled(
      requests.map((request) => collaboration.setVote(thread.publicCapability, identity, request)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "participant_vote_request_limit", status: 409 } },
    ]);
    const receiptCount = await env.DB.prepare(`SELECT COUNT(*) AS count
      FROM thread_collaboration_vote_requests WHERE participant_id = ?`)
      .bind(participant.id).first<{ count: number }>();
    expect(receiptCount?.count).toBe(THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT);

    const winner = results.findIndex((result) => result.status === "fulfilled");
    await expect(collaboration.setVote(thread.publicCapability, identity, requests[winner]!))
      .resolves.toMatchObject({ replayed: true });
    await expect(collaboration.setVote(thread.publicCapability, identity, {
      ...requests[winner]!,
      vote: requests[winner]!.vote === "up" ? "down" : "up",
    })).rejects.toMatchObject({ code: "request_conflict" });

    await env.DB.prepare(`INSERT INTO thread_collaboration_vote_requests
        (thread_id, participant_id, request_key, contribution_id, vote, mutation_token)
      VALUES (?, ?, 'direct-over-participant-cap', ?, 'up', ?)`)
      .bind(participant.thread_id, participant.id, song.id, nanoid()).run();
    expect((await env.DB.prepare(`SELECT COUNT(*) AS count
      FROM thread_collaboration_vote_requests WHERE participant_id = ?`)
      .bind(participant.id).first<{ count: number }>())?.count)
      .toBe(THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT);
    expect((await collaboration.snapshot(thread.publicCapability, identity))?.collaborationRevision)
      .toBe(before.collaborationRevision + 1);
  });

  it("atomically enforces the per-Jam vote-receipt cap under concurrent participants", async () => {
    const { thread } = await setup();
    const song = await addSong(thread.publicCapability);
    const identities = await Promise.all(Array.from({ length: 11 }, (_, index) => anonymous(`thread-limit-${index}-${nanoid()}`)));
    const joined = [];
    for (const [index, identity] of identities.entries()) {
      joined.push(await collaboration.join(thread.publicCapability, identity, `Voter ${index + 1}`));
    }
    const stored = await Promise.all(joined.map((result) => storedParticipant(
      thread.publicCapability,
      result.participant.id,
    )));
    for (let index = 0; index < 9; index += 1) {
      await seedVoteRequests(
        stored[index]!.thread_id,
        stored[index]!.id,
        song.id,
        THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT,
        `thread-full-${index}`,
      );
    }
    await seedVoteRequests(
      stored[9]!.thread_id,
      stored[9]!.id,
      song.id,
      THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT - 1,
      "thread-near-full",
    );
    expect(9 * THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT
      + THREAD_VOTE_REQUESTS_PER_PARTICIPANT_LIMIT - 1)
      .toBe(THREAD_VOTE_REQUESTS_PER_THREAD_LIMIT - 1);

    const results = await Promise.allSettled([
      collaboration.setVote(thread.publicCapability, identities[9]!, {
        contributionId: song.id,
        vote: "up",
        requestKey: "thread-limit-final-a",
      }),
      collaboration.setVote(thread.publicCapability, identities[10]!, {
        contributionId: song.id,
        vote: "down",
        requestKey: "thread-limit-final-b",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "vote_request_limit", status: 409 } },
    ]);
    const receiptCount = await env.DB.prepare(`SELECT COUNT(*) AS count
      FROM thread_collaboration_vote_requests WHERE thread_id = ?`)
      .bind(stored[0]!.thread_id).first<{ count: number }>();
    expect(receiptCount?.count).toBe(THREAD_VOTE_REQUESTS_PER_THREAD_LIMIT);

    await env.DB.prepare(`INSERT INTO thread_collaboration_vote_requests
        (thread_id, participant_id, request_key, contribution_id, vote, mutation_token)
      VALUES (?, ?, 'direct-over-thread-cap', ?, 'up', ?)`)
      .bind(stored[10]!.thread_id, stored[10]!.id, song.id, nanoid()).run();
    expect((await env.DB.prepare(`SELECT COUNT(*) AS count
      FROM thread_collaboration_vote_requests WHERE thread_id = ?`)
      .bind(stored[0]!.thread_id).first<{ count: number }>())?.count)
      .toBe(THREAD_VOTE_REQUESTS_PER_THREAD_LIMIT);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS count
      FROM thread_collaboration_votes WHERE thread_id = ?`)
      .bind(stored[0]!.thread_id).first<{ count: number }>())?.count).toBe(1);
  });

  it("collapses participants and votes when provider accounts become linked", async () => {
    const { thread } = await setup();
    const song = await addSong(thread.publicCapability);
    const accounts = new D1AccountStore(env.DB);
    const spotify = await accounts.upsert("spotify", `spotify-${nanoid()}`, "Spotify");
    const apple = await accounts.upsert("apple", `apple-${nanoid()}`, "Apple");
    const profiles = new D1ProfileStore(env.DB);
    await profiles.seed(spotify.id, { displayName: "Jordan", avatarUrl: null });
    await profiles.seed(apple.id, { displayName: "Jordan", avatarUrl: null });
    const spotifyIdentity = { kind: "account" as const, accountId: spotify.id };
    const appleIdentity = { kind: "account" as const, accountId: apple.id };
    const first = await collaboration.join(thread.publicCapability, spotifyIdentity, "Jordan");
    await collaboration.join(thread.publicCapability, appleIdentity, "Also Jordan");
    await collaboration.setVote(thread.publicCapability, spotifyIdentity, {
      contributionId: song.id,
      vote: "up",
      requestKey: "spotify-vote",
    });
    await collaboration.setVote(thread.publicCapability, appleIdentity, {
      contributionId: song.id,
      vote: "down",
      requestKey: "apple-vote",
    });

    await env.DB.prepare("UPDATE accounts SET group_id = ? WHERE id = ?")
      .bind(spotify.groupId, apple.id)
      .run();
    expect(await collaboration.participant(thread.publicCapability, appleIdentity)).toEqual(first.participant);
    const linked = await collaboration.snapshot(thread.publicCapability, appleIdentity);
    expect(linked).toMatchObject({
      participantCount: 1,
      viewer: { participant: first.participant },
      votes: [{ contributionId: song.id, upvotes: 1, downvotes: 0, score: 1, myVote: "up" }],
    });

    await collaboration.setVote(thread.publicCapability, appleIdentity, {
      contributionId: song.id,
      vote: "clear",
      requestKey: "linked-clear",
    });
    expect((await collaboration.snapshot(thread.publicCapability, spotifyIdentity))?.votes[0]).toEqual({
      contributionId: song.id,
      upvotes: 0,
      downvotes: 0,
      score: 0,
      myVote: null,
    });
  });

  it("rejects cross-Thread and removed-song votes and freezes participant writes on close", async () => {
    const first = await setup();
    const second = await setup();
    const firstSong = await addSong(first.thread.publicCapability);
    const secondSong = await addSong(second.thread.publicCapability);
    const identity = await anonymous();
    await collaboration.join(first.thread.publicCapability, identity, "Harper");

    await expect(collaboration.setVote(first.thread.publicCapability, identity, {
      contributionId: secondSong.id, vote: "up", requestKey: "other-thread",
    })).rejects.toMatchObject({ code: "contribution_not_found" });
    await threads.manage(first.authorization, {
      kind: "remove",
      id: firstSong.id,
      expectedRevision: 1,
      requestKey: "remove-song",
    });
    await expect(collaboration.setVote(first.thread.publicCapability, identity, {
      contributionId: firstSong.id, vote: "up", requestKey: "removed-song",
    })).rejects.toMatchObject({ code: "contribution_not_found" });
    await threads.manage(first.authorization, {
      kind: "close",
      expectedRevision: 2,
      requestKey: "close-thread",
    });
    await expect(collaboration.postMessage(first.thread.publicCapability, identity, {
      text: "Too late",
      requestKey: "closed-message",
    })).rejects.toMatchObject({ code: "closed" });
    await expect(collaboration.join(first.thread.publicCapability, await anonymous(), "New"))
      .rejects.toMatchObject({ code: "closed" });
  });

  it("soft-deletes messages with scoped management authorization, including after close", async () => {
    const first = await setup();
    const second = await setup();
    const identity = await anonymous();
    await collaboration.join(first.thread.publicCapability, identity, "Indigo");
    const posted = await collaboration.postMessage(first.thread.publicCapability, identity, {
      text: "Please remove this",
      requestKey: "remove-me",
    });

    expect(await collaboration.moderateMessage(second.authorization, posted.message.id)).toBe("not_found");
    await threads.manage(first.authorization, {
      kind: "close",
      expectedRevision: 0,
      requestKey: "close-after-message",
    });
    expect(await collaboration.moderateMessage(first.authorization, posted.message.id)).toBe("removed");
    expect(await collaboration.moderateMessage(first.authorization, posted.message.id)).toBe("already_removed");
    expect((await collaboration.snapshot(first.thread.publicCapability))?.messages).toMatchObject([{
      id: posted.message.id,
      text: "",
      deleted: true,
    }]);
  });
});
