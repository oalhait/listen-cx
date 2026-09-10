import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { D1LinkStore } from "./db.js";
import { D1JamStore, type AcceptJamContributionInput } from "./jam-db.js";
import {
  authorizeJamManagementCapability,
  fingerprintJamContributionInput,
  type JamManagementAuthorization,
} from "./jam.js";

const LINK_SLUG = "song234";

async function seedLink(slug = LINK_SLUG): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO links
       (slug, isrc, title, artist, artwork_url, spotify_url, apple_url, complete)
     VALUES (?, NULL, 'Kingston', 'Faye Webster', 'https://images.example/cover.jpg', ?, NULL, 0)`,
  )
    .bind(slug, "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")
    .run();
}

async function contributionInput(
  requestKey: string,
  catalogId = requestKey,
): Promise<AcceptJamContributionInput> {
  const identity = {
    sourceProvider: "spotify" as const,
    sourceCatalogId: catalogId,
    sourceStorefront: "us",
  };
  return {
    ...identity,
    linkSlug: LINK_SLUG,
    requestKey,
    inputFingerprint: await fingerprintJamContributionInput(identity),
  };
}

async function managementAuthorization(
  store: D1JamStore,
  publicCapability: string,
  managementCapability: string,
): Promise<JamManagementAuthorization> {
  const authorization = await authorizeJamManagementCapability(
    store,
    publicCapability,
    managementCapability,
  );
  if (!authorization) throw new Error("Jam management authorization failed");
  return authorization;
}

describe("D1JamStore", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM thread_contributions").run();
    await env.DB.prepare("DELETE FROM threads").run();
    await env.DB.prepare("DELETE FROM links").run();
    await seedLink();
  });

  it("uses the preserved foreign keys and creates a Jam with digest-only management storage", async () => {
    const store = new D1JamStore(env.DB, { maxJams: 10 });

    const created = await store.create("  Friday night  ");

    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    expect(created.jam.title).toBe("Friday night");
    expect(created.jam.publicCapability).not.toBe(created.managementCapability);
    const authorization = await authorizeJamManagementCapability(
      store,
      created.jam.publicCapability,
      created.managementCapability,
    );
    expect(authorization).toMatchObject({ publicCapability: created.jam.publicCapability });
    await expect(
      authorizeJamManagementCapability(store, created.jam.publicCapability, "C".repeat(22)),
    ).resolves.toBeNull();

    const persisted = await env.DB.prepare(
      "SELECT management_digest FROM threads WHERE id = ?",
    )
      .bind(created.jam.id)
      .first<{ management_digest: string }>();
    expect(persisted?.management_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted?.management_digest).not.toBe(created.managementCapability);
    await expect(store.get(created.jam.publicCapability)).resolves.toMatchObject({
      jam: { title: "Friday night" },
      contributions: [],
      totalContributions: 0,
      contributionLimit: 500,
    });
  });

  it("deletes only link rows that no Jam contribution references", async () => {
    const links = new D1LinkStore(env.DB);
    await seedLink("orphan2");

    await links.deleteIfUnreferenced("orphan2");
    expect(await links.get("orphan2")).toBeNull();

    const jams = new D1JamStore(env.DB, { maxJams: 10 });
    const created = await jams.create("Referenced link");
    if (created.status !== "created") throw new Error("Jam not created");
    const accepted = await jams.acceptContribution(
      created.jam.publicCapability,
      await contributionInput("referenced-link"),
    );
    expect(accepted.status).toBe("accepted");

    await links.deleteIfUnreferenced(LINK_SLUG);
    expect(await links.get(LINK_SLUG)).not.toBeNull();
  });

  it("atomically enforces the total Jam ceiling", async () => {
    const store = new D1JamStore(env.DB, { maxJams: 1 });

    const results = await Promise.all([store.create("First"), store.create("Second")]);

    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results.filter((result) => result.status === "limit_reached")).toHaveLength(1);
  });

  it("does not allow one Jam's management authorization to mutate another Jam", async () => {
    const store = new D1JamStore(env.DB, { maxJams: 10 });
    const firstJam = await store.create("First Jam");
    const secondJam = await store.create("Second Jam");
    if (firstJam.status !== "created" || secondJam.status !== "created") {
      throw new Error("Jams not created");
    }
    const secondContribution = await store.acceptContribution(
      secondJam.jam.publicCapability,
      await contributionInput("second-jam-song"),
    );
    if (secondContribution.status !== "accepted") {
      throw new Error("Contribution not accepted");
    }
    const firstAuthorization = await managementAuthorization(
      store,
      firstJam.jam.publicCapability,
      firstJam.managementCapability,
    );

    await expect(
      store.removeContribution(firstAuthorization, secondContribution.contribution.id),
    ).resolves.toEqual({ status: "not_found" });
    await expect(store.get(secondJam.jam.publicCapability)).resolves.toMatchObject({
      jam: { closedAt: null },
      contributions: [{ id: secondContribution.contribution.id }],
    });
  });

  it("orders contributions and makes repeated request keys idempotent", async () => {
    const store = new D1JamStore(env.DB, { maxJams: 10 });
    const created = await store.create("Queue");
    if (created.status !== "created") throw new Error("Jam not created");
    const firstInput = await contributionInput("request-1", "catalog-1");

    const [first, second] = await Promise.all([
      store.acceptContribution(created.jam.publicCapability, firstInput),
      store.acceptContribution(
        created.jam.publicCapability,
        await contributionInput("request-2", "catalog-2"),
      ),
    ]);
    const retry = await store.acceptContribution(created.jam.publicCapability, firstInput);
    const conflict = await store.acceptContribution(
      created.jam.publicCapability,
      await contributionInput("request-1", "changed-catalog"),
    );

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(retry).toMatchObject({ status: "existing" });
    expect(conflict).toEqual({ status: "conflict" });
    const view = await store.get(created.jam.publicCapability);
    expect(view?.contributions.map((contribution) => contribution.position)).toEqual([1, 2]);
    expect(view?.contributions[0]).toEqual(expect.objectContaining({
      id: expect.any(Number),
      linkSlug: LINK_SLUG,
      position: 1,
      title: "Kingston",
      artist: "Faye Webster",
      artworkUrl: "https://images.example/cover.jpg",
    }));
  });

  it("soft-removes contributions without reusing positions and counts them toward lifetime capacity", async () => {
    const store = new D1JamStore(env.DB, { maxJams: 10, maxContributionsPerJam: 2 });
    const created = await store.create("History");
    if (created.status !== "created") throw new Error("Jam not created");
    const firstInput = await contributionInput("request-1");
    const first = await store.acceptContribution(created.jam.publicCapability, firstInput);
    const second = await store.acceptContribution(
      created.jam.publicCapability,
      await contributionInput("request-2"),
    );
    if (first.status !== "accepted" || second.status !== "accepted") {
      throw new Error("Contributions not accepted");
    }
    const authorization = await managementAuthorization(
      store,
      created.jam.publicCapability,
      created.managementCapability,
    );

    const removed = await store.removeContribution(authorization, first.contribution.id);
    const removedAgain = await store.removeContribution(authorization, first.contribution.id);
    const retry = await store.acceptContribution(created.jam.publicCapability, firstInput);
    const overLifetimeLimit = await store.acceptContribution(
      created.jam.publicCapability,
      await contributionInput("request-3"),
    );

    expect(removed).toMatchObject({
      status: "removed",
      contribution: { position: 1, removedAt: expect.any(String) },
    });
    expect(removedAgain).toMatchObject({ status: "removed", contribution: { position: 1 } });
    expect(retry).toMatchObject({
      status: "existing",
      contribution: { id: first.contribution.id, removedAt: expect.any(String) },
    });
    expect(overLifetimeLimit).toEqual({ status: "limit_reached" });
    await expect(store.get(created.jam.publicCapability)).resolves.toMatchObject({
      contributions: [{ id: second.contribution.id, position: 2 }],
      totalContributions: 2,
    });
  });

  it("caps the active queue at 50 under concurrency and frees capacity after removal", async () => {
    const store = new D1JamStore(env.DB, { maxJams: 10 });
    const created = await store.create("Capacity");
    if (created.status !== "created") throw new Error("Jam not created");
    let firstContributionId = 0;
    for (let index = 1; index <= 49; index += 1) {
      const accepted = await store.acceptContribution(
        created.jam.publicCapability,
        await contributionInput(`seed-${index}`),
      );
      if (accepted.status !== "accepted") throw new Error("Contribution not accepted");
      if (index === 1) firstContributionId = accepted.contribution.id;
    }

    const finalResults = await Promise.all([
      store.acceptContribution(created.jam.publicCapability, await contributionInput("last-a")),
      store.acceptContribution(created.jam.publicCapability, await contributionInput("last-b")),
    ]);
    expect(finalResults.filter((result) => result.status === "accepted")).toHaveLength(1);
    expect(finalResults.filter((result) => result.status === "full")).toHaveLength(1);
    await expect(
      store.preflightContribution(
        created.jam.publicCapability,
        "preflight-at-capacity",
        "unused-fingerprint",
      ),
    ).resolves.toEqual({ status: "full" });

    const authorization = await managementAuthorization(
      store,
      created.jam.publicCapability,
      created.managementCapability,
    );
    await store.removeContribution(authorization, firstContributionId);
    const replacement = await store.acceptContribution(
      created.jam.publicCapability,
      await contributionInput("replacement"),
    );
    expect(replacement).toMatchObject({ status: "accepted", contribution: { position: 51 } });
    expect((await store.get(created.jam.publicCapability))?.contributions).toHaveLength(50);
  });

  it("closes idempotently, keeps retries observable, and rejects new contributions", async () => {
    const store = new D1JamStore(env.DB, { maxJams: 10 });
    const created = await store.create("Closing time");
    if (created.status !== "created") throw new Error("Jam not created");
    const originalInput = await contributionInput("before-close");
    const accepted = await store.acceptContribution(created.jam.publicCapability, originalInput);
    if (accepted.status !== "accepted") throw new Error("Contribution not accepted");
    const authorization = await managementAuthorization(
      store,
      created.jam.publicCapability,
      created.managementCapability,
    );

    const closed = await store.close(authorization);
    const closedAgain = await store.close(authorization);
    const retry = await store.preflightContribution(
      created.jam.publicCapability,
      originalInput.requestKey,
      originalInput.inputFingerprint,
    );
    const freshPreflight = await store.preflightContribution(
      created.jam.publicCapability,
      "after-close",
      "unused-fingerprint",
    );
    const addAfterClose = await store.acceptContribution(
      created.jam.publicCapability,
      await contributionInput("after-close"),
    );

    expect(closed).toMatchObject({ status: "closed", jam: { closedAt: expect.any(String) } });
    expect(closedAgain).toEqual(closed);
    expect(retry).toMatchObject({ status: "existing", contribution: { id: accepted.contribution.id } });
    expect(freshPreflight).toEqual({ status: "closed" });
    expect(addAfterClose).toEqual({ status: "closed" });
  });
});
