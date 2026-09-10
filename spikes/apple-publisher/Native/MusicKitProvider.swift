import Foundation
import MusicKit

@MainActor final class MusicKitProvider: PlaylistProvider {
    private var songs: [Song] = []
    private let prefix = "listen.cx Apple spike · "
    var playlistURL: URL?

    func prepare(_ ids: [String]) async throws {
        guard MusicAuthorization.currentStatus == .authorized,
              try await MusicSubscription.current.canPlayCatalogContent else {
            throw PublishError.unavailableTrack
        }
        var available: [String: Song] = [:]
        for id in Set(ids) {
            let request = MusicCatalogResourceRequest<Song>(matching: \.id, equalTo: MusicItemID(id))
            let response = try await request.response()
            guard let song = response.items.first, song.id.rawValue == id, song.playParameters != nil else {
                throw PublishError.unavailableTrack
            }
            available[id] = song
        }
        songs = try orderedItems(ids: ids, available: available)
    }

    func create(key: String) async throws -> String {
        let playlist = try await MusicLibrary.shared.createPlaylist(
            name: prefix + key,
            description: "Disposable Apple publisher feasibility experiment",
            items: songs
        )
        playlistURL = playlist.url
        return playlist.id.rawValue
    }

    func replace(id: String) async throws {
        let playlist = try await ownedSpike(id)
        _ = try await MusicLibrary.shared.edit(playlist, items: songs)
    }

    private func ownedSpike(_ id: String) async throws -> Playlist {
        guard MusicAuthorization.currentStatus == .authorized else { throw PublishError.unavailableTrack }
        var request = MusicLibraryRequest<Playlist>()
        request.filter(matching: \.id, equalTo: MusicItemID(id))
        let response = try await request.response()
        guard let playlist = response.items.first, playlist.id.rawValue == id,
              playlist.name.hasPrefix(prefix) else { throw PublishError.wrongPlaylist }
        playlistURL = playlist.url
        return playlist
    }

    func read(id: String) async throws -> [String] {
        _ = try await ownedSpike(id)
        guard let encodedID = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else {
            throw PublishError.invalidReadback
        }
        let path = "/v1/me/library/playlists/\(encodedID)/tracks"
        var next: String? = path + "?limit=100"
        var visited = Set<URL>()
        var ids: [String] = []
        while let location = next {
            let url = try appleReadURL(location, expectedPath: path)
            guard visited.insert(url).inserted, visited.count <= 10 else { throw PublishError.invalidReadback }
            let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
            let response = try await MusicDataRequest(urlRequest: request).response()
            let page = try JSONDecoder().decode(TrackPage.self, from: response.data)
            ids += try page.catalogIDs()
            guard ids.count <= 100 else { throw PublishError.invalidReadback }
            next = page.next
        }
        return ids
    }
}
