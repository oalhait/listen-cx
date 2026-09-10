// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ApplePublisherSpike",
    platforms: [.macOS(.v14), .iOS(.v16)],
    products: [.library(name: "PublisherCore", targets: ["PublisherCore"])],
    targets: [
        .target(name: "PublisherCore", path: "Core", exclude: ["Publisher.test.swift"]),
        .testTarget(name: "PublisherCoreTests", dependencies: ["PublisherCore"], path: "Core", sources: ["Publisher.test.swift"])
    ]
)
