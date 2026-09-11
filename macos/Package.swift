// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PostmasterMenuBar",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "PostmasterMenuBar", targets: ["PostmasterMenuBar"])],
    targets: [.executableTarget(name: "PostmasterMenuBar")]
)
