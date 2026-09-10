import Foundation

struct DesiredRevision: Codable, Equatable, Sendable {
    let playlistKey: String
    let revision: Int
    let trackIDs: [String]
}

struct Destination: Codable, Equatable {
    var playlistKey: String
    var playlistID: String?
    var applied: DesiredRevision?
    var pending: DesiredRevision?
}

enum PublishError: Error, Equatable {
    case invalidDesired, busy, wrongPlaylist, staleRevision, conflictingRevision
    case unresolvedCreation, pendingRevision, readbackMismatch, unavailableTrack, invalidReadback
}

@MainActor protocol PlaylistProvider {
    func prepare(_ ids: [String]) async throws
    func create(key: String) async throws -> String
    func replace(id: String) async throws
    func read(id: String) async throws -> [String]
}

@MainActor protocol DestinationStore {
    func load() throws -> Destination?
    func save(_ state: Destination) throws
}

@MainActor final class Publisher {
    let provider: any PlaylistProvider
    let store: any DestinationStore
    let attempts: Int
    let pause: () async throws -> Void
    private var busy = false

    init(provider: any PlaylistProvider, store: any DestinationStore, attempts: Int = 4,
         pause: @escaping () async throws -> Void = { try await Task.sleep(for: .seconds(2)) }) {
        self.provider = provider
        self.store = store
        self.attempts = max(1, attempts)
        self.pause = pause
    }

    func publish(_ desired: DesiredRevision) async throws -> Destination {
        guard !busy else { throw PublishError.busy }
        busy = true
        defer { busy = false }
        guard !desired.playlistKey.isEmpty, desired.playlistKey.utf8.count <= 128,
              desired.revision > 0, desired.revision <= 9_007_199_254_740_991,
              desired.trackIDs.count <= 100,
              desired.trackIDs.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 128 }) else {
            throw PublishError.invalidDesired
        }
        var state = try store.load() ?? Destination(playlistKey: desired.playlistKey)
        guard state.playlistKey == desired.playlistKey else { throw PublishError.wrongPlaylist }
        if let latest = state.pending ?? state.applied {
            guard desired.revision >= latest.revision else { throw PublishError.staleRevision }
            if desired.revision == latest.revision && desired != latest {
                throw PublishError.conflictingRevision
            }
        }
        if state.pending != nil {
            guard state.playlistID != nil else { throw PublishError.unresolvedCreation }
            guard state.pending == desired else { throw PublishError.pendingRevision }
        }
        if let id = state.playlistID, state.pending == desired || state.applied == desired {
            if try await provider.read(id: id) == desired.trackIDs {
                state.applied = desired
                state.pending = nil
                try store.save(state)
                return state
            }
            if state.pending == nil { throw PublishError.readbackMismatch }
        }
        try await provider.prepare(desired.trackIDs)
        try Task.checkCancellation()
        state.pending = desired
        try store.save(state)
        if let id = state.playlistID {
            try await provider.replace(id: id)
        } else {
            state.playlistID = try await provider.create(key: desired.playlistKey)
            try store.save(state)
        }
        guard let id = state.playlistID else { throw PublishError.unresolvedCreation }
        for attempt in 0..<attempts {
            try Task.checkCancellation()
            if try await provider.read(id: id) == desired.trackIDs {
                state.applied = desired
                state.pending = nil
                try store.save(state)
                return state
            }
            if attempt + 1 < attempts { try await pause() }
        }
        throw PublishError.readbackMismatch
    }
}

@MainActor final class FileDestinationStore: DestinationStore {
    let url: URL
    init(url: URL) { self.url = url }
    func load() throws -> Destination? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(Destination.self, from: Data(contentsOf: url))
    }
    func save(_ state: Destination) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(state).write(to: url, options: .atomic)
    }
}

struct TrackPage: Decodable {
    struct Resource: Decodable {
        struct Attributes: Decodable {
            struct Parameters: Decodable { let catalogId: String? }
            let playParams: Parameters?
        }
        let id: String
        let type: String
        let attributes: Attributes?
    }
    let data: [Resource]
    let next: String?

    func catalogIDs() throws -> [String] {
        try data.map { resource in
            let id: String?
            switch resource.type {
            case "songs": id = resource.id
            case "library-songs": id = resource.attributes?.playParams?.catalogId
            default: throw PublishError.invalidReadback
            }
            guard let id, !id.isEmpty else { throw PublishError.invalidReadback }
            return id
        }
    }
}

func appleReadURL(_ next: String, expectedPath: String) throws -> URL {
    guard let url = URL(string: next, relativeTo: URL(string: "https://api.music.apple.com")!)?.absoluteURL,
          url.scheme == "https", url.host == "api.music.apple.com", url.port == nil,
          url.user == nil, url.password == nil, url.fragment == nil,
          url.path == URL(string: expectedPath, relativeTo: URL(string: "https://api.music.apple.com")!)?.path else {
        throw PublishError.invalidReadback
    }
    return url
}

func orderedItems<T>(ids: [String], available: [String: T]) throws -> [T] {
    try ids.map {
        guard let item = available[$0] else { throw PublishError.unavailableTrack }
        return item
    }
}
