import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { D1ThreadStore } from "../src/thread-db.js";
import { authorizeManagementCapability } from "../src/thread-security.js";
import { fingerprintContributionInput } from "../src/thread.js";

const LINK_SLUG = "song234";

async function seedLink(slug = LINK_SLUG) {
  await env.DB.prepare(
    `INSERT INTO links
       (slug, isrc, title, artist, artwork_url, spotify_url, apple_url, complete)
     VALUES (?, NULL, 'Kingston', 'Faye Webster', NULL, ?, NULL, 0)`,
  )
    .bind(slug, "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")
    .run();
}

async function contributionInput(requestKey: string, catalogId = requestKey) {
  const identity = {
    linkSlug: LINK_SLUG,
    sourceProvider: "spotify" as const,
    sourceCatalogId: catalogId,
    sourceStorefront: "us",
  };
  return {
    ...identity,
    requestKey,
    inputFingerprint: await fingerprintContributionInput(identity),
  };
}

async function managementAuthorization(
  store: D1ThreadStore,
  publicCapability: string,
  managementCapability: string,
) {
  const authorization = await authorizeManagementCapability(
    store,
    publicCapability,
    managementCapability,
  );
  if (!authorization) throw new Error("management authorization failed");
  return authorization;
}

describe("D1ThreadStore", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM thread_contributions").run();
    await env.DB.prepare("DELETE FROM threads").run();
    await env.DB.prepare("DELETE FROM links").run();
    await seedLink();
  });

  it("applies the contribution foreign keys and active-order index", async () => {
    const foreignKeys = await env.DB.prepare(
      "PRAGMA foreign_key_list(thread_contributions)",
    ).all<{ table: string; from: string; to: string }>();
    const indexes = await env.DB.prepare("PRAGMA index_list(thread_contributions)").all<{
      name: string;
      partial: number;
    }>();

    expect(foreignKeys.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "links", from: "link_slug", to: "slug" }),
        expect.objectContaining({ table: "threads", from: "thread_id", to: "id" }),
      ]),
    );
    expect(indexes.results).toContainEqual(
      expect.objectContaining({ name: "idx_thread_contributions_active", partial: 1 }),
    );
  });

  it("creates separate capabilities while persisting only the management digest", async () => {
    const store = new D1ThreadStore(env.DB, { maxThreads: 10 });

    const result = await store.create("  Friday night  ");

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.thread.title).toBe("Friday night");
    expect(result.thread.publicCapability).not.toBe(result.managementCapability);
    await expect(
      authorizeManagementCapability(
        store,
        result.thread.publicCapability,
        result.managementCapability,
      ),
    ).resolves.toMatchObject({ publicCapability: result.thread.publicCapability });
    const persisted = await env.DB.prepare(
      "SELECT management_digest FROM threads WHERE id = ?",
    )
      .bind(result.thread.id)
      .first<{ management_digest: string }>();
    expect(persisted?.management_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted?.management_digest).not.toBe(result.managementCapability);
    expect(
      await authorizeManagementCapability(
        store,
        result.thread.publicCapability,
        "C".repeat(22),
      ),
    ).toBeNull();
  });

  it("enforces the injected total Thread ceiling atomically", async () => {
    const store = new D1ThreadStore(env.DB, { maxThreads: 1 });

    const results = await Promise.all([store.create("First"), store.create("Second")]);

    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results.filter((result) => result.status === "limit_reached")).toHaveLength(1);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM threads").first<{
      count: number;
    }>();
    expect(count?.count).toBe(1);
  });

  it("returns an existing contribution for the same request and conflicts on changed input", async () => {
    const store = new D1ThreadStore(env.DB, { maxThreads: 10 });
    const created = await store.create("Duplicates");
    if (created.status !== "created") throw new Error("thread not created");
    const original = await contributionInput("request-1", "catalog-1");

    const accepted = await store.acceptContribution(created.thread.publicCapability, original);
    const duplicate = await store.acceptContribution(created.thread.publicCapability, original);
    const conflict = await store.acceptContribution(
      created.thread.publicCapability,
      await contributionInput("request-1", "catalog-2"),
    );

    expect(accepted.status).toBe("accepted");
    expect(duplicate).toMatchObject({ status: "existing" });
    expect(conflict).toEqual({ status: "conflict" });
    if (accepted.status === "accepted" && duplicate.status === "existing") {
      expect(duplicate.contribution.id).toBe(accepted.contribution.id);
    }
    expect((await store.getView(created.thread.publicCapability))?.contributions).toHaveLength(1);
  });

  it("returns an existing contribution when its Thread later becomes full", async () => {
    const store = new D1ThreadStore(env.DB, { maxThreads: 10 });
    const created = await store.create("Retry precedence");
    if (created.status !== "created") throw new Error("thread not created");
    const original = await contributionInput("original");
    const accepted = await store.acceptContribution(created.thread.publicCapability, original);
    if (accepted.status !== "accepted") throw new Error("contribution not accepted");
    for (let index = 2; index <= 50; index += 1) {
      const result = await store.acceptContribution(
        created.thread.publicCapability,
        await contributionInput(`fill-${index}`),
      );
      expect(result.status).toBe("accepted");
    }

    const retry = await store.acceptContribution(created.thread.publicCapability, original);

    expect(retry).toMatchObject({
      status: "existing",
      contribution: { id: accepted.contribution.id },
    });
  });

  it("commits concurrent contributions once in a stable order", async () => {
    const store = new D1ThreadStore(env.DB, { maxThreads: 10 });
    const created = await store.create("Concurrent order");
    if (created.status !== "created") throw new Error("thread not created");

    const results = await Promise.all([
      store.acceptContribution(created.thread.publicCapability, await contributionInput("add-a")),
      store.acceptContribution(created.thread.publicCapability, await contributionInput("add-b")),
    ]);

    expect(results.every((result) => result.status === "accepted")).toBe(true);
    expect(
      (await store.getView(created.thread.publicCapability))?.contributions.map(
        (contribution) => contribution.position,
      ),
    ).toEqual([1, 2]);
  });

  it("preserves stable positions and hides soft-removed contributions", async () => {
    const store = new D1ThreadStore(env.DB, { maxThreads: 10 });
    const created = await store.create("Order");
    if (created.status !== "created") throw new Error("thread not created");
    const first = await store.acceptContribution(
      created.thread.publicCapability,
      await contributionInput("request-1"),
    );
    const second = await store.acceptContribution(
      created.thread.publicCapability,
      await contributionInput("request-2"),
    );
    if (first.status !== "accepted" || second.status !== "accepted") {
      throw new Error("contributions not accepted");
    }

    const authorization = await managementAuthorization(
      store,
      created.thread.publicCapability,
      created.managementCapability,
    );
    const removed = await store.removeContribution(authorization, first.contribution.id);
    const removedAgain = await store.removeContribution(authorization, first.contribution.id);

    expect(removed.status).toBe("removed");
    expect(removedAgain.status).toBe("removed");
    if (removed.status === "removed") {
      expect(removed.contribution).toMatchObject({
        position: 1,
        sourceProvider: "spotify",
        sourceCatalogId: "request-1",
        sourceStorefront: "us",
      });
    }
    expect(second.contribution.position).toBe(2);
    expect((await store.getView(created.thread.publicCapability))?.contributions).toEqual([
      expect.objectContaining({ id: second.contribution.id, position: 2 }),
    ]);
  });

  it("accepts only one fiftieth contribution under concurrency", async () => {
    const store = new D1ThreadStore(env.DB, { maxThreads: 10 });
    const created = await store.create("Capacity");
    if (created.status !== "created") throw new Error("thread not created");
    for (let index = 1; index <= 49; index += 1) {
      const result = await store.acceptContribution(
        created.thread.publicCapability,
        await contributionInput(`seed-${index}`),
      );
      expect(result.status).toBe("accepted");
    }

    const results = await Promise.all([
      store.acceptContribution(created.thread.publicCapability, await contributionInput("last-a")),
      store.acceptContribution(created.thread.publicCapability, await contributionInput("last-b")),
    ]);

    expect(results.filter((result) => result.status === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result.status === "full")).toHaveLength(1);
    expect((await store.getView(created.thread.publicCapability))?.contributions).toHaveLength(50);
  });

  it("frees active capacity after removal without reusing a position", async () => {
    const store = new D1ThreadStore(env.DB, { maxThreads: 10 });
    const created = await store.create("Capacity recovery");
    if (created.status !== "created") throw new Error("thread not created");
    let firstContributionId = 0;
    for (let index = 1; index <= 50; index += 1) {
      const result = await store.acceptContribution(
        created.thread.publicCapability,
        await contributionInput(`seed-${index}`),
      );
      if (result.status !== "accepted") throw new Error("contribution not accepted");
      if (index === 1) firstContributionId = result.contribution.id;
    }
    const authorization = await managementAuthorization(
      store,
      created.thread.publicCapability,
      created.managementCapability,
    );

    await store.removeContribution(authorization, firstContributionId);
    const replacement = await store.acceptContribution(
      created.thread.publicCapability,
      await contributionInput("replacement"),
    );

    expect(replacement).toMatchObject({ status: "accepted", contribution: { position: 51 } });
    expect((await store.getView(created.thread.publicCapability))?.contributions).toHaveLength(50);
  });

  it("linearizes a full-capacity add against removal without an indeterminate error", async () => {
    const store = new D1ThreadStore(env.DB, { maxThreads: 10 });
    const created = await store.create("Capacity race");
    if (created.status !== "created") throw new Error("thread not created");
    let firstContributionId = 0;
    for (let index = 1; index <= 50; index += 1) {
      const result = await store.acceptContribution(
        created.thread.publicCapability,
        await contributionInput(`seed-${index}`),
      );
      if (result.status !== "accepted") throw new Error("contribution not accepted");
      if (index === 1) firstContributionId = result.contribution.id;
    }
    const authorization = await managementAuthorization(
      store,
      created.thread.publicCapability,
      created.managementCapability,
    );

    const acceptancePromise = store.acceptContribution(
      created.thread.publicCapability,
      await contributionInput("racing-replacement"),
    );
    const removalPromise = store.removeContribution(authorization, firstContributionId);
    const [acceptance, removal] = await Promise.all([acceptancePromise, removalPromise]);

    expect(removal.status).toBe("removed");
    expect(["accepted", "full"]).toContain(acceptance.status);
    expect((await store.getView(created.thread.publicCapability))?.contributions).toHaveLength(
      acceptance.status === "accepted" ? 50 : 49,
    );
  });

  it("linearizes close against acceptance", async () => {
    const store = new D1ThreadStore(env.DB, { maxThreads: 10 });
    const created = await store.create("Close race");
    if (created.status !== "created") throw new Error("thread not created");
    const authorization = await managementAuthorization(
      store,
      created.thread.publicCapability,
      created.managementCapability,
    );

    const [acceptance, closure] = await Promise.all([
      store.acceptContribution(
        created.thread.publicCapability,
        await contributionInput("racing-add"),
      ),
      store.close(authorization),
    ]);

    expect(closure.status).toBe("closed");
    expect(["accepted", "closed"]).toContain(acceptance.status);
    const active = await store.getView(created.thread.publicCapability);
    expect(active?.thread.closedAt).not.toBeNull();
    expect(active?.contributions).toHaveLength(acceptance.status === "accepted" ? 1 : 0);

    const closedAgain = await store.close(authorization);
    expect(closedAgain).toMatchObject({
      status: "closed",
      thread: { closedAt: closure.status === "closed" ? closure.thread.closedAt : null },
    });
  });

  it("allows idempotent removal after close without reopening", async () => {
    const store = new D1ThreadStore(env.DB, { maxThreads: 10 });
    const created = await store.create("Closed removal");
    if (created.status !== "created") throw new Error("thread not created");
    const accepted = await store.acceptContribution(
      created.thread.publicCapability,
      await contributionInput("before-close"),
    );
    if (accepted.status !== "accepted") throw new Error("contribution not accepted");
    const authorization = await managementAuthorization(
      store,
      created.thread.publicCapability,
      created.managementCapability,
    );

    await store.close(authorization);
    const removed = await store.removeContribution(authorization, accepted.contribution.id);
    const addAfterRemoval = await store.acceptContribution(
      created.thread.publicCapability,
      await contributionInput("after-close"),
    );

    expect(removed.status).toBe("removed");
    expect(addAfterRemoval).toEqual({ status: "closed" });
    const active = await store.getView(created.thread.publicCapability);
    expect(active?.thread.closedAt).not.toBeNull();
    expect(active?.contributions).toHaveLength(0);
  });
});
