import SwiftUI
@preconcurrency import MusicKit
import UniformTypeIdentifiers

@main struct ApplePublisherSpikeApp: App {
    var body: some Scene { WindowGroup { SpikeConsole() } }
}

@MainActor struct SpikeConsole: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var desiredJSON = #"{"playlistKey":"apple-publisher-spike-01","revision":1,"trackIDs":["A","B","C"]}"#
    @State private var endpoint = "http://127.0.0.1:8790/desired"
    @State private var importing = false
    @State private var working = false
    @State private var output = "Replace A/B/C with catalog song IDs. This console writes only new spike playlists."
    @State private var provider = MusicKitProvider()
    @State private var publisher: Publisher?

    var body: some View {
        NavigationStack {
            Form {
                Section("Desired revision handoff") {
                    TextField("Fixture endpoint", text: $endpoint)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Fetch desired JSON") {
                        perform {
                            guard let url = URL(string: endpoint), ["http", "https"].contains(url.scheme ?? "") else {
                                throw PublishError.invalidDesired
                            }
                            let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
                            let (data, response) = try await URLSession.shared.data(for: request)
                            guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 32_768 else {
                                throw PublishError.invalidDesired
                            }
                            _ = try JSONDecoder().decode(DesiredRevision.self, from: data)
                            desiredJSON = String(decoding: data, as: UTF8.self)
                            output = "Desired JSON fetched; no provider write performed."
                        }
                    }
                    Button("Import desired JSON file") { importing = true }
                    TextEditor(text: $desiredJSON).frame(minHeight: 130).font(.system(.caption, design: .monospaced))
                }
                Section("Publisher device") {
                    Button("Authorize MusicKit") {
                        perform { output = "Music authorization: \(await MusicAuthorization.request())" }
                    }
                    Button("Use local developer token") {
                        MusicDataRequest.tokenProvider = LoopbackMusicTokenProvider()
                        output = "Local developer-token helper selected for this app session; user authorization is still handled by MusicKit."
                    }
                    Button("Check MusicKit access") {
                        perform {
                            let desired = try JSONDecoder().decode(DesiredRevision.self, from: Data(desiredJSON.utf8))
                            let storefront = try await MusicDataRequest.currentCountryCode
                            try await provider.prepare(desired.trackIDs)
                            output = "MusicKit storefront \(storefront), subscription and \(desired.trackIDs.count) catalog entries verified; no provider write performed."
                        }
                    }
                    Button("Publish spike revision") {
                        perform {
                            if publisher == nil {
                                let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                                publisher = Publisher(provider: provider, store: FileDestinationStore(url: folder.appendingPathComponent("apple-spike-destination.json")))
                            }
                            let desired = try JSONDecoder().decode(DesiredRevision.self, from: Data(desiredJSON.utf8))
                            let start = Date()
                            guard let publisher else { return }
                            let state = try await publisher.publish(desired)
                            let encoder = JSONEncoder()
                            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                            output = "Verified on publisher at \(Date().ISO8601Format()) in \(Date().timeIntervalSince(start))s\n" + String(decoding: try encoder.encode(state), as: UTF8.self)
                        }
                    }
                    Text("Foreground developer harness. Sharing happens manually in Apple Music; a returned URL does not prove subscriber propagation.")
                    if let url = provider.playlistURL { Link("Open provider playlist", destination: url) }
                }
                Section("Evidence") { Text(output).font(.caption.monospaced()).textSelection(.enabled) }
            }
            .disabled(working)
            .navigationTitle("Apple publisher spike")
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
                do {
                    let url = try result.get()
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    desiredJSON = String(decoding: try Data(contentsOf: url), as: UTF8.self)
                } catch { output = "Import failed: \(error)" }
            }
            .onChange(of: scenePhase) { phase in
                print("Apple spike lifecycle \(Date().ISO8601Format()) \(phase)")
            }
        }
    }

    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        working = true
        Task { @MainActor in
            defer { working = false }
            do { try await action() }
            catch { output = "Not applied by this attempt: \(error)\nRetry the identical pending revision after resolving the cause." }
        }
    }
}
