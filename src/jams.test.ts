import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { D1LinkStore } from "./db.js";
import {
  addTrackToJam,
  closeJam,
  createJam,
  getJam,
  joinJam,
  listJamMessages,
  postJamMessage,
  removeJamMessage,
  removeTrackFromJam,
  setJamTrackVote,
  type JamActions,
} from "./jams.js";
import type { Resolved } from "./resolve.js";
import { D1ThreadCollaborationStore } from "./thread-collaboration-db.js";
import { D1ThreadStore } from "./thread-db.js";

const TRACK_URL = "https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO";
const TRACK: Resolved = {
  isrc: null,
  complete: false,
  title: "Cataracts",
  artist: "Freddie Gibbs, Madlib",
  artworkUrl: null,
  spotifyUrl: TRACK_URL,
  appleUrl: null,
};
const PARTICIPANT_KEY = "p".repeat(43);

const resolver = { resolve: vi.fn<(_: string) => Promise<Resolved | null>>() };
const store = new D1LinkStore(env.DB);
const threadStore = new D1ThreadStore(env.DB);
const collaborationStore = new D1ThreadCollaborationStore(env.DB);
const onJamChange = vi.fn();
const actions = {
  resolver,
  store,
  threadStore,
  collaborationStore,
  jamsEnabled: true,
  baseUrl: "https://listen.test",
  onJamChange,
} satisfies JamActions;

async function clean(): Promise<void> {
  for (const table of [
    "thread_collaboration_vote_requests",
    "thread_collaboration_votes",
    "thread_collaboration_messages",
    "thread_mutations",
    "thread_creations",
    "thread_contributions",
    "thread_collaboration_participants",
    "thread_publications",
    "thread_collaboration_state",
    "threads",
    "links",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

describe("canonical Jam actions", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    resolver.resolve.mockReset().mockResolvedValue(TRACK);
    onJamChange.mockReset();
    await clean();
  });

  it("rejects disabled actions before touching canonical storage or providers", async () => {
    const create = vi.spyOn(threadStore, "create");
    const disabled = { ...actions, jamsEnabled: false };

    await expect(createJam(disabled, "Disabled")).rejects.toMatchObject({ code: "jams_disabled" });
    await expect(addTrackToJam(disabled, "invalid", TRACK_URL, "disabled"))
      .rejects.toMatchObject({ code: "jams_disabled" });
    expect(create).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("creates the canonical Thread and returns a human sharing URL without storing its secret", async () => {
    const created = await createJam(actions, " Friday night ");

    expect(created).toMatchObject({
      title: "Friday night",
      jamUrl: `https://listen.test/t/${created.jamId}`,
      shareUrl: `https://listen.test/t/${created.jamId}`,
      apiUrl: `https://listen.test/api/threads/${created.jamId}`,
      managementToken: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    });
    const row = await env.DB.prepare("SELECT management_digest, revision FROM threads WHERE public_capability = ?")
      .bind(created.jamId).first<{ management_digest: string; revision: number }>();
    expect(row).toEqual({ management_digest: expect.stringMatching(/^[a-f0-9]{64}$/), revision: 0 });
    expect(row?.management_digest).not.toBe(created.managementToken);
    expect(await getJam(actions, created.jamId)).toMatchObject({
      shareUrl: created.shareUrl,
      revision: 0,
      participantCount: 0,
      tracks: [],
    });
  });

  it("adds through the canonical revision, receipt, verification, ordering, and publication path", async () => {
    const created = await createJam(actions, "Canonical");
    const accepted = await addTrackToJam(actions, created.jamId, TRACK_URL, "mcp-add-1");
    const replay = await addTrackToJam(actions, created.jamId, TRACK_URL, "mcp-add-1");

    expect(accepted).toMatchObject({ status: "accepted", position: 1 });
    expect(replay).toMatchObject({
      status: "existing",
      contributionId: accepted.contributionId,
      position: 1,
    });
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(onJamChange).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare(`SELECT t.revision, c.sort_order, c.source_verified,
      m.revision AS receipt_revision FROM threads t
      JOIN thread_contributions c ON c.thread_id = t.id
      JOIN thread_mutations m ON m.thread_id = t.id AND m.request_key = 'mcp-add-1'
      WHERE t.public_capability = ?`).bind(created.jamId).first())
      .toMatchObject({ revision: 1, sort_order: 1, source_verified: 1, receipt_revision: 1 });
    expect((await getJam(actions, created.jamId)).tracks).toEqual([
      expect.objectContaining({
        contributionId: accepted.contributionId,
        position: 1,
        addedBy: null,
        upvotes: 0,
        score: 0,
      }),
    ]);
  });

  it("retries canonical stale revisions so concurrent public additions are not lost", async () => {
    const created = await createJam(actions, "Concurrent");
    const secondUrl = "https://open.spotify.com/track/1v1oIWf2Xgh54kIWuKsDf6";
    resolver.resolve.mockImplementation(async (url) => ({
      ...TRACK,
      title: url === secondUrl ? "Second" : TRACK.title,
      spotifyUrl: url,
    }));

    const results = await Promise.all([
      addTrackToJam(actions, created.jamId, TRACK_URL, "parallel-a"),
      addTrackToJam(actions, created.jamId, secondUrl, "parallel-b"),
    ]);

    expect(results.map((result) => result.status)).toEqual(["accepted", "accepted"]);
    expect((await threadStore.get(created.jamId))?.revision).toBe(2);
    expect((await getJam(actions, created.jamId)).tracks.map((track) => track.position)).toEqual([1, 2]);
  });

  it("rejects provider identity drift without creating a link or mutation", async () => {
    const created = await createJam(actions, "Verify");
    resolver.resolve.mockResolvedValueOnce({ ...TRACK, spotifyUrl: "https://open.spotify.com/track/1v1oIWf2Xgh54kIWuKsDf6" });

    await expect(addTrackToJam(actions, created.jamId, TRACK_URL, "identity-drift"))
      .rejects.toMatchObject({ code: "invalid_track_url" });
    expect((await threadStore.get(created.jamId))?.revision).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM links").first<{ count: number }>())?.count).toBe(0);
  });

  it("removes and closes through management authorization and remains idempotent", async () => {
    const created = await createJam(actions, "Managed");
    const added = await addTrackToJam(actions, created.jamId, TRACK_URL, "managed-song");

    await expect(removeTrackFromJam(actions, created.jamId, "x".repeat(22), added.contributionId))
      .rejects.toMatchObject({ code: "jam_management_denied" });
    const removed = await removeTrackFromJam(actions, created.jamId, created.managementToken, added.contributionId);
    const removedAgain = await removeTrackFromJam(actions, created.jamId, created.managementToken, added.contributionId);
    const closed = await closeJam(actions, created.jamId, created.managementToken);
    const closedAgain = await closeJam(actions, created.jamId, created.managementToken);

    expect(removedAgain).toEqual(removed);
    expect(closed.closedAt).toEqual(expect.any(String));
    expect(closedAgain).toEqual(closed);
    expect((await threadStore.get(created.jamId))?.revision).toBe(3);
    expect(onJamChange).toHaveBeenCalledTimes(3);
  });
});

describe("Jam collaboration actions", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    resolver.resolve.mockReset().mockResolvedValue(TRACK);
    onJamChange.mockReset();
    await clean();
  });

  it("attributes an added track only to the joined participant capability", async () => {
    const created = await createJam(actions, "Attributed friends");
    const otherKey = "q".repeat(43);
    const first = await joinJam(actions, created.jamId, "Priya", PARTICIPANT_KEY);
    await joinJam(actions, created.jamId, "Quinn", otherKey);

    const added = await addTrackToJam(
      actions,
      created.jamId,
      TRACK_URL,
      "participant-song",
      PARTICIPANT_KEY,
    );
    const jam = await getJam(actions, created.jamId);
    expect(jam.tracks[0]).toMatchObject({
      contributionId: added.contributionId,
      addedBy: {
        participantId: first.participant.id,
        displayName: "Priya",
        avatarUrl: null,
      },
    });
    await expect(addTrackToJam(
      actions,
      created.jamId,
      TRACK_URL,
      "participant-song",
      otherKey,
    )).rejects.toMatchObject({ code: "request_key_conflict" });
    await expect(addTrackToJam(
      actions,
      created.jamId,
      TRACK_URL,
      "not-joined-song",
      "z".repeat(43),
    )).rejects.toMatchObject({ code: "join_required" });
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ added, jam })).not.toContain(PARTICIPANT_KEY);
    expect(JSON.stringify({ added, jam })).not.toContain(otherKey);
    const privateDigest = await env.DB.prepare(`SELECT anonymous_digest
      FROM thread_collaboration_participants WHERE public_id = ?`)
      .bind(first.participant.id).first<string>("anonymous_digest");
    expect(JSON.stringify(jam)).not.toContain(privateDigest!);
  });

  it("joins, chats idempotently, votes, lists, and moderates without exposing the private key", async () => {
    const created = await createJam(actions, "Friends");
    const added = await addTrackToJam(actions, created.jamId, TRACK_URL, "friend-song");

    const joined = await joinJam(actions, created.jamId, " Alice ", PARTICIPANT_KEY);
    const joinedAgain = await joinJam(actions, created.jamId, "Alice", PARTICIPANT_KEY);
    const posted = await postJamMessage(actions, created.jamId, PARTICIPANT_KEY, " Great pick! ", "message-1");
    const replay = await postJamMessage(actions, created.jamId, PARTICIPANT_KEY, "Great pick!", "message-1");
    const vote = await setJamTrackVote(actions, created.jamId, PARTICIPANT_KEY, added.contributionId, "up", "vote-1");
    const messages = await listJamMessages(actions, created.jamId, 0, 10);
    const removed = await removeJamMessage(actions, created.jamId, created.managementToken, posted.message.id);
    const removedAgain = await removeJamMessage(actions, created.jamId, created.managementToken, posted.message.id);

    expect(joined).toMatchObject({ status: "joined", participant: { displayName: "Alice" } });
    expect(joinedAgain).toMatchObject({ status: "existing", participant: { id: joined.participant.id } });
    expect(replay).toMatchObject({ replayed: true, message: { id: posted.message.id } });
    expect(vote).toMatchObject({ replayed: false, vote: { contributionId: added.contributionId, upvotes: 1, score: 1, myVote: "up" } });
    expect(messages).toMatchObject({ participantCount: 1, messages: [{ text: "Great pick!" }] });
    expect(removed.status).toBe("removed");
    expect(removedAgain.status).toBe("already_removed");
    expect(JSON.stringify({ joined, posted, vote, messages })).not.toContain(PARTICIPANT_KEY);
    expect(await env.DB.prepare("SELECT anonymous_digest FROM thread_collaboration_participants").first<string>("anonymous_digest"))
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires the exact private participant capability and freezes social mutations on close", async () => {
    const created = await createJam(actions, "Closed social");
    await joinJam(actions, created.jamId, "Alice", PARTICIPANT_KEY);
    await closeJam(actions, created.jamId, created.managementToken);

    await expect(postJamMessage(actions, created.jamId, "z".repeat(43), "Nope", "wrong-user"))
      .rejects.toMatchObject({ code: "join_required" });
    await expect(postJamMessage(actions, created.jamId, PARTICIPANT_KEY, "Too late", "closed-message"))
      .rejects.toMatchObject({ code: "jam_closed" });
    await expect(joinJam(actions, created.jamId, "Bob", "b".repeat(43)))
      .rejects.toMatchObject({ code: "jam_closed" });
    await expect(joinJam(actions, created.jamId, "Bad", "not-a-capability"))
      .rejects.toMatchObject({ code: "invalid_participant" });
  });
});
