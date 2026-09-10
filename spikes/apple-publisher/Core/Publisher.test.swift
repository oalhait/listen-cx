import Foundation
import Testing
@testable import PublisherCore

@MainActor final class MemoryStore: DestinationStore {
    var state: Destination?
    var failSave = false
    func load() throws -> Destination? { state }
    func save(_ state: Destination) throws {
        if failSave { throw CocoaError(.fileWriteUnknown) }
        self.state = state
    }
}

@MainActor final class FakeProvider: PlaylistProvider {
    var prepared: [String] = []
    var tracks: [String] = []
    var writes: [String] = []
    var delayedReads: [[String]] = []
    var unavailable = false
    var createFails = false
    var replaceFails = false
    var onPrepare: (() async throws -> Void)?
    func prepare(_ ids: [String]) async throws {
        try await onPrepare?()
        if unavailable { throw PublishError.unavailableTrack }
        prepared = ids
    }
    func create(key: String) async throws -> String {
        writes.append("create")
        if createFails { throw URLError(.networkConnectionLost) }
        tracks = prepared
        return "new-spike-id"
    }
    func replace(id: String) async throws {
        writes.append(id)
        if replaceFails { throw URLError(.networkConnectionLost) }
        tracks = prepared
    }
    func read(id: String) async throws -> [String] {
        delayedReads.isEmpty ? tracks : delayedReads.removeFirst()
    }
}

@MainActor struct PublisherTests {
    func desired(_ revision: Int = 1, _ tracks: [String] = ["1", "2", "3"]) -> DesiredRevision {
        DesiredRevision(playlistKey: "opaque-key", revision: revision, trackIDs: tracks)
    }
    func setup() -> (Publisher, FakeProvider, MemoryStore) {
        let provider = FakeProvider()
        let store = MemoryStore()
        return (Publisher(provider: provider, store: store, attempts: 3, pause: {}), provider, store)
    }

    @Test func createsThenRemovesAndReordersWithoutChangingIdentity() async throws {
        let (publisher, provider, _) = setup()
        let first = try await publisher.publish(desired())
        let second = try await publisher.publish(desired(2, ["3", "1", "4"]))
        #expect(first.playlistID == second.playlistID)
        #expect(second.applied == desired(2, ["3", "1", "4"]))
        #expect(provider.tracks == ["3", "1", "4"])
        #expect(provider.writes == ["create", "new-spike-id"])
    }

    @Test func identicalRevisionReadsWithoutWritingAndConflictingOrStaleRevisionsFail() async throws {
        let (publisher, provider, _) = setup()
        _ = try await publisher.publish(desired(2))
        _ = try await publisher.publish(desired(2))
        #expect(provider.writes == ["create"])
        await #expect(throws: PublishError.staleRevision) { try await publisher.publish(desired()) }
        await #expect(throws: PublishError.conflictingRevision) { try await publisher.publish(desired(2, ["4"])) }
        #expect(provider.writes == ["create"])
    }

    @Test func preservesDuplicatesAndCanRequestAnEmptyPlaylist() async throws {
        let (publisher, provider, _) = setup()
        _ = try await publisher.publish(desired(1, ["1", "1", "2"]))
        #expect(provider.tracks == ["1", "1", "2"])
        _ = try await publisher.publish(desired(2, []))
        #expect(provider.tracks.isEmpty)
    }

    @Test func unavailableTracksPreventAnyMutationOrPendingState() async throws {
        let (publisher, provider, store) = setup()
        provider.unavailable = true
        await #expect(throws: PublishError.unavailableTrack) { try await publisher.publish(desired()) }
        #expect(provider.writes.isEmpty)
        #expect(store.state == nil)
    }

    @Test func waitsForExactReadbackAndLeavesUnverifiedRevisionPending() async throws {
        let (publisher, provider, store) = setup()
        provider.delayedReads = [["3", "2", "1"], ["1", "2"]]
        _ = try await publisher.publish(desired())
        #expect(store.state?.applied == desired())
        provider.delayedReads = [["1", "2", "3"], [], []]
        await #expect(throws: PublishError.readbackMismatch) { try await publisher.publish(desired(2, ["4"])) }
        #expect(store.state?.applied == desired())
        #expect(store.state?.pending == desired(2, ["4"]))
    }

    @Test func relaunchVerifiesPendingWriteBeforeAcceptingAnotherRevision() async throws {
        let (publisher, provider, store) = setup()
        provider.delayedReads = [[], [], []]
        await #expect(throws: PublishError.readbackMismatch) { try await publisher.publish(desired()) }
        let relaunched = Publisher(provider: provider, store: store, pause: {})
        await #expect(throws: PublishError.pendingRevision) { try await relaunched.publish(desired(2)) }
        _ = try await relaunched.publish(desired())
        #expect(provider.writes == ["create"])
        #expect(store.state?.pending == nil)
    }

    @Test func uncertainCreationNeverAutomaticallyCreatesAnotherPlaylist() async throws {
        let (publisher, provider, store) = setup()
        provider.createFails = true
        await #expect(throws: (any Error).self) { try await publisher.publish(desired()) }
        #expect(store.state?.pending == desired())
        let relaunched = Publisher(provider: provider, store: store)
        await #expect(throws: PublishError.unresolvedCreation) { try await relaunched.publish(desired()) }
        #expect(provider.writes == ["create"])
    }

    @Test func interruptedEditRetriesSameDestinationAndNeverAcceptsNewRevisionFirst() async throws {
        let (publisher, provider, store) = setup()
        _ = try await publisher.publish(desired())
        provider.replaceFails = true
        await #expect(throws: (any Error).self) { try await publisher.publish(desired(2, ["4"])) }
        provider.replaceFails = false
        let relaunched = Publisher(provider: provider, store: store, pause: {})
        _ = try await relaunched.publish(desired(2, ["4"]))
        #expect(store.state?.applied == desired(2, ["4"]))
        #expect(provider.writes == ["create", "new-spike-id", "new-spike-id"])
    }

    @Test func invalidInputAndWrongKeysNeverWrite() async throws {
        let (publisher, provider, _) = setup()
        for invalid in [desired(0), desired(1, [""]), desired(1, Array(repeating: "1", count: 101)),
                        DesiredRevision(playlistKey: "", revision: 1, trackIDs: [])] {
            await #expect(throws: PublishError.invalidDesired) { try await publisher.publish(invalid) }
        }
        #expect(provider.writes.isEmpty)
        _ = try await publisher.publish(desired())
        await #expect(throws: PublishError.wrongPlaylist) {
            try await publisher.publish(DesiredRevision(playlistKey: "other", revision: 2, trackIDs: []))
        }
    }

    @Test func failedDurableSavePreventsMutation() async throws {
        let (publisher, provider, store) = setup()
        store.failSave = true
        await #expect(throws: (any Error).self) { try await publisher.publish(desired()) }
        #expect(provider.writes.isEmpty)
    }

    @Test func concurrentCallsAreRejectedWhileProviderIsSuspended() async throws {
        let (publisher, provider, _) = setup()
        provider.onPrepare = {
            await #expect(throws: PublishError.busy) { try await publisher.publish(desired(2)) }
        }
        _ = try await publisher.publish(desired())
    }
}

@MainActor struct AdapterContractTests {
    @Test func fileStoreSurvivesRelaunchAndRejectsCorruption() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let store = FileDestinationStore(url: url)
        #expect(try store.load() == nil)
        let desired = DesiredRevision(playlistKey: "key", revision: 1, trackIDs: ["1"])
        let state = Destination(playlistKey: "key", playlistID: "spike", pending: desired)
        try store.save(state)
        #expect(try FileDestinationStore(url: url).load() == state)
        try Data("broken".utf8).write(to: url)
        #expect(throws: (any Error).self) { try store.load() }
    }

    @Test func readbackUsesCatalogIdentityAndPreservesOrderAndDuplicates() throws {
        let data = Data(#"{"data":[{"id":"i.lib","type":"library-songs","attributes":{"playParams":{"catalogId":"3"}}},{"id":"1","type":"songs"},{"id":"1","type":"songs"}],"next":"/v1/me/library/playlists/p/tracks?offset=3"}"#.utf8)
        let page = try JSONDecoder().decode(TrackPage.self, from: data)
        #expect(try page.catalogIDs() == ["3", "1", "1"])
        #expect(page.next?.contains("offset=3") == true)
    }

    @Test func missingIdentityAndUnsupportedItemsNeverBecomeEmptySuccess() throws {
        for json in [#"{"data":[{"id":"i.lib","type":"library-songs"}]}"#,
                     #"{"data":[{"id":"1","type":"music-videos"}]}"#,
                     #"{"data":[{"id":"","type":"songs"}]}"#] {
            let page = try JSONDecoder().decode(TrackPage.self, from: Data(json.utf8))
            #expect(throws: PublishError.invalidReadback) { try page.catalogIDs() }
        }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(TrackPage.self, from: Data("{}".utf8)) }
        #expect(try JSONDecoder().decode(TrackPage.self, from: Data(#"{"data":[]}"#.utf8)).catalogIDs() == [])
    }

    @Test func paginationRejectsOtherOriginsAndOtherResources() throws {
        let path = "/v1/me/library/playlists/p/tracks"
        #expect(try appleReadURL(path + "?offset=10", expectedPath: path).host == "api.music.apple.com")
        for next in ["https://evil.test" + path, "//evil.test" + path, "/v1/me/library/songs", path + "/../other"] {
            #expect(throws: PublishError.invalidReadback) { try appleReadURL(next, expectedPath: path) }
        }
    }

    @Test func paginationAcceptsEquivalentEncodedPlaylistIDs() throws {
        let path = "/v1/me/library/playlists/p%2EABC/tracks"
        #expect(try appleReadURL(path + "?offset=10", expectedPath: path).host == "api.music.apple.com")
        #expect(try appleReadURL("/v1/me/library/playlists/p.ABC/tracks?offset=10", expectedPath: path).host == "api.music.apple.com")
    }

    @Test func resolutionPreservesDuplicatesAndRejectsMissingSongs() throws {
        #expect(try orderedItems(ids: ["2", "1", "2"], available: ["1": "A", "2": "B"]) == ["B", "A", "B"])
        #expect(throws: PublishError.unavailableTrack) { try orderedItems(ids: ["3"], available: ["1": "A"]) }
    }
}
