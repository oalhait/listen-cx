import { describe, expect, it } from "vitest";
import { selectTrackMatch, type CatalogTrack } from "./track-matching.js";

const source: CatalogTrack = { provider: "apple", id: "123", storefront: "us", title: "A Song", artist: "Artist & Guest", album: "Original", durationMs: 200000, isrc: "USABC2400001", explicit: false, playable: true };
const track = (changes: Partial<CatalogTrack> = {}): CatalogTrack => ({ ...source, provider: "spotify", id: "a".repeat(22), ...changes });
const sandstormApple: CatalogTrack = { ...source, id: "1453748449", title: "Sandstorm (feat. JID)", artist: "Mereba", album: "The Jungle Is the Only Way Out", durationMs: 179027, isrc: "USUM71901124", explicit: true };
const sandstormSpotify = track({ ...sandstormApple, provider: "spotify", id: "a".repeat(22), artist: "Mereba, JID", durationMs: 179026 });

describe("selectTrackMatch", () => {
  it.each(["isrc", "metadata"] as const)("matches shared title feature credits in both directions using %s", (method) => {
    const compilation = { ...sandstormApple, id: "1523934588", album: "Compilation" };
    const clean = { ...sandstormApple, id: "1453741315", explicit: false, isrc: "USUM71901562" };
    expect(selectTrackMatch(sandstormSpotify, [clean, compilation, sandstormApple], method)).toMatchObject({ status: "matched", selected: sandstormApple, candidates: [sandstormApple] });
    expect(selectTrackMatch(sandstormApple, [sandstormSpotify], method)).toMatchObject({ status: "matched", selected: sandstormSpotify });
  });

  it.each(["Cover Artist", "JID, Mereba", "Mereba, Uncredited Performer"])("rejects altered primary or uncredited artists: %s", (artist) => {
    expect(selectTrackMatch(sandstormApple, [{ ...sandstormSpotify, artist }], "metadata").status).toBe("unavailable");
  });

  it("requires the same feature qualifier in both titles", () => {
    expect(selectTrackMatch(sandstormApple, [{ ...sandstormSpotify, title: "Sandstorm" }], "metadata").status).toBe("unavailable");
    expect(selectTrackMatch(sandstormApple, [{ ...sandstormSpotify, title: "Sandstorm (feat. Other)" }], "metadata").status).toBe("unavailable");
    expect(selectTrackMatch({ ...sandstormApple, title: "Sandstorm" }, [{ ...sandstormSpotify, title: "Sandstorm" }], "metadata").status).toBe("unavailable");
  });

  it("does not infer a Spotify rating from feature credit agreement", () => {
    expect(selectTrackMatch(sandstormApple, [{ ...sandstormSpotify, explicit: null }], "metadata").status).toBe("ambiguous");
  });

  it("collapses equivalent releases and prefers the source album deterministically", () => {
    const original = track({ id: "b".repeat(22), durationMs: 201000 });
    const compilation = track({ album: "Greatest Hits" });
    for (const candidates of [[compilation, original], [original, compilation]]) {
      expect(selectTrackMatch(source, candidates, "isrc")).toMatchObject({ status: "matched", selected: original, candidates: [original] });
    }
  });

  it("automatically matches normalized metadata and collaborator punctuation", () => {
    expect(selectTrackMatch({ ...source, isrc: null }, [track({ title: "A—SONG!", artist: "Artist, Guest", durationMs: 202999 })], "metadata").status).toBe("matched");
  });

  it.each(["Live", "Remix", "Acoustic", "Instrumental", "Clean", "Remastered"])("rejects contradictory %s recording qualifiers even with an ISRC", (version) => {
    expect(selectTrackMatch(source, [track({ title: `A Song (${version})` })], "isrc").status).toBe("unavailable");
  });

  it("keeps distinct recording groups ambiguous even when one album matches", () => {
    const result = selectTrackMatch(source, [track(), track({ id: "b".repeat(22), isrc: "USABC2400002", album: "Compilation" })], "metadata");
    expect(result).toMatchObject({ status: "ambiguous", selected: null });
    expect(result.candidates).toHaveLength(2);
  });

  it("uses exact album release evidence to distinguish metadata-only releases without overriding a known ISRC", () => {
    const spotifySource: CatalogTrack = { provider: "spotify", id: "7EcE5yCPVZaZut1JqowbcI", storefront: "us", title: "Faneto", artist: "Chief Keef", album: "Back from the Dead 2", releaseDate: "2015-06-16", durationMs: 206654, isrc: null, explicit: true, playable: true };
    const single: CatalogTrack = { ...spotifySource, provider: "apple", id: "1614504695", album: "Faneto - Single", durationMs: 206655, isrc: "USZEG1500799" };
    const currentAlbum: CatalogTrack = { ...spotifySource, provider: "apple", id: "1614548303", durationMs: 206655, isrc: "USZEG1500799" };
    const originalAlbum: CatalogTrack = { ...spotifySource, provider: "apple", id: "930701578", releaseDate: "2014-10-31", durationMs: 206602, isrc: "USAE81401954" };
    expect(selectTrackMatch(spotifySource, [single, originalAlbum, currentAlbum], "metadata")).toMatchObject({ status: "matched", selected: currentAlbum, candidates: [currentAlbum] });
    expect(selectTrackMatch({ ...spotifySource, releaseDate: null }, [single, originalAlbum, currentAlbum], "metadata")).toMatchObject({ status: "ambiguous", selected: null });
    expect(selectTrackMatch({ ...spotifySource, isrc: single.isrc }, [single, originalAlbum, currentAlbum], "metadata")).toMatchObject({ status: "ambiguous", selected: null });
  });

  it("accepts Spotify's multi-token Ms. artist prefix without treating one-word stage names as aliases", () => {
    const lauryn = track({ provider: "spotify", id: "2GFExyKXf9383tSRSrEHEt", title: "Can't Take My Eyes Off of You - (I Love You Baby)", artist: "Ms. Lauryn Hill", album: "The Miseducation of Lauryn Hill", durationMs: 221466, isrc: null, explicit: false });
    const apple = { ...lauryn, provider: "apple" as const, id: "1276760758", title: "Can't Take My Eyes Off of You (I Love You Baby)", artist: "Lauryn Hill", durationMs: 221467 };
    expect(selectTrackMatch(lauryn, [apple], "metadata")).toMatchObject({ status: "matched", selected: apple });
    expect(selectTrackMatch(lauryn, [{ ...apple, album: "Other Album" }], "metadata").status).toBe("unavailable");
    expect(selectTrackMatch({ ...lauryn, artist: "Ms. Dynamite" }, [{ ...apple, artist: "Dynamite" }], "metadata").status).toBe("unavailable");
  });

  it("rejects unplayable tracks, conflicting explicitness, duration, and artist", () => {
    for (const changes of [{ playable: false }, { explicit: true }, { durationMs: 203001 }, { artist: "Other" }]) {
      expect(selectTrackMatch(source, [track(changes)], "metadata").status).toBe("unavailable");
    }
  });

  it("uses the tighter two-percent tolerance for short recordings", () => {
    expect(selectTrackMatch({ ...source, durationMs: 30000 }, [track({ durationMs: 30601 })], "metadata").status).toBe("unavailable");
  });

  it.each([{ durationMs: null }, { durationMs: 0 }])("retains metadata suggestions when required facts are missing: %j", (changes) => {
    expect(selectTrackMatch({ ...source, ...changes }, [track()], "metadata")).toMatchObject({ status: "ambiguous", selected: null, candidates: [track()] });
  });

  it("accepts unrated Apple with nonexplicit Spotify symmetrically without inventing a rating", () => {
    const apple = { ...source, explicit: null };
    const spotify = track();
    expect(selectTrackMatch(apple, [spotify], "metadata").status).toBe("matched");
    expect(selectTrackMatch(spotify, [apple], "metadata")).toMatchObject({ status: "matched", selected: { explicit: null } });
  });

  it("retains suggestions for unknown Spotify ratings and explicit Spotify paired with unrated Apple", () => {
    expect(selectTrackMatch(source, [track({ explicit: null })], "metadata").status).toBe("ambiguous");
    expect(selectTrackMatch(track({ explicit: null }), [source], "metadata").status).toBe("ambiguous");
    expect(selectTrackMatch({ ...source, explicit: null }, [track({ explicit: true })], "metadata").status).toBe("ambiguous");
    expect(selectTrackMatch(track({ explicit: true }), [{ ...source, explicit: null }], "metadata").status).toBe("ambiguous");
  });

  it("does not collapse unknown ISRC recordings or choose by album alone", () => {
    expect(selectTrackMatch(source, [track({ isrc: null }), track({ id: "b".repeat(22), isrc: null })], "metadata").status).toBe("ambiguous");
  });

  it("requires the ISRC query results to contain the source ISRC", () => {
    expect(selectTrackMatch(source, [track({ isrc: "USABC2400002" })], "isrc").status).toBe("unavailable");
    expect(selectTrackMatch({ ...source, isrc: "US-ABC-24-00001" }, [track()], "isrc").status).toBe("matched");
  });

  it("does not collapse conflicting clean and explicit releases when source explicitness is unknown", () => {
    expect(selectTrackMatch({ ...source, explicit: null }, [track(), track({ id: "b".repeat(22), explicit: true })], "isrc").status).toBe("ambiguous");
  });

  it("does not collapse same-ISRC releases with contradictory durations when source duration is unknown", () => {
    expect(selectTrackMatch({ ...source, durationMs: null }, [track(), track({ id: "b".repeat(22), durationMs: 240000 })], "isrc").status).toBe("ambiguous");
  });
});
