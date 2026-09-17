import SwiftUI
import AppKit
import ServiceManagement

struct TrackingEvent: Codable, Identifiable { let id: String; let occurredAt: String; let status: String; let statusDetail: String; let description: String; let location: String }
enum PackageDirection: String, CaseIterable, Identifiable { case inbound, outbound; var id: String { rawValue }; var title: String { rawValue.capitalized } }
struct Package: Codable, Identifiable { let id: String; let trackingNumber: String; let carrier: String; let name: String; let status: String; let statusDetail: String; let eta: String?; let trackerId: String?; let notificationMode: String; let archived: Bool; let createdAt: String; let updatedAt: String; let lastCheckedAt: String?; let lastEventAt: String?; let nextCheckAt: String?; let error: String?; let events: [TrackingEvent]; let direction: String?; var carrierTrackingUrl: String? = nil }
struct PackageEnvelope: Codable { let packages: [Package] }
struct AddInput: Codable { let trackingNumber: String; let carrier: String?; let name: String?; let direction: String
    init(trackingNumber: String, carrier: String?, name: String?, direction: String = PackageDirection.inbound.rawValue) { self.trackingNumber = trackingNumber; self.carrier = carrier; self.name = name; self.direction = direction }
}
struct AddRequest: Codable { let items: [AddInput] }
struct AddResult: Codable { let trackingNumber: String; let package: Package?; let error: String? }
struct AddEnvelope: Codable { let results: [AddResult] }
struct Health: Codable { let status: String; let version: String; let easypost: IntegrationHealth }
struct IntegrationHealth: Codable { let configured: Bool; let status: String; let message: String }

@MainActor final class Store: ObservableObject {
    @Published var packages: [Package] = []
    @Published var serverURL: String { didSet { defaults.set(serverURL, forKey: "serverURL") } }
    @Published var isLoading = false
    @Published var isOnline = false
    @Published var lastSynced: Date?
    @Published var errorMessage: String?
    @Published var showingAdd = false
    @Published var launchAtLogin: Bool { didSet { defaults.set(launchAtLogin, forKey: "launchAtLogin"); updateLaunchAtLogin() } }
    private let defaults = UserDefaults.standard
    private var timer: Timer?
    private var visible = false
    let defaultURL = "https://yufeihl.tail1bd003.ts.net:8443"

    init() {
        let origin = UserDefaults.standard.string(forKey: "serverURL") ?? "https://yufeihl.tail1bd003.ts.net:8443"
        serverURL = origin
        launchAtLogin = UserDefaults.standard.bool(forKey: "launchAtLogin")
        if let data = UserDefaults.standard.data(forKey: "packages.\(origin)"), let saved = try? JSONDecoder().decode([Package].self, from: data) { packages = saved }
        lastSynced = UserDefaults.standard.object(forKey: "lastSynced.\(origin)") as? Date
    }
    func setPopoverVisible(_ value: Bool) {
        visible = value; timer?.invalidate()
        if value { refresh(); timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in Task { @MainActor in self?.refresh() } } }
    }
    func refresh() {
        guard !isLoading else { return }; isLoading = true
        let origin = serverURL
        Task { [weak self] in
            guard let self else { return }
            do { let result: PackageEnvelope = try await request(path: "/api/v1/packages?archived=all", origin: origin); guard serverURL == origin else { isLoading = false; refresh(); return }; packages = result.packages; isOnline = true; lastSynced = Date(); defaults.set(try? JSONEncoder().encode(packages), forKey: cacheKey(origin)); defaults.set(lastSynced, forKey: syncKey(origin)); errorMessage = nil }
            catch { guard serverURL == origin else { isLoading = false; refresh(); return }; isOnline = false; errorMessage = "Unable to connect. Showing saved data." }
            isLoading = false
        }
    }
    func add(trackingNumber: String, name: String, carrier: String?, direction: PackageDirection = .inbound, completion: @escaping (Bool) -> Void) {
        guard isOnline else { errorMessage = "Connect to the server before adding a package."; completion(false); return }
        isLoading = true
        let origin = serverURL
        Task { [weak self] in
            guard let self else { return }
            do { let result: AddEnvelope = try await request(path: "/api/v1/packages", origin: origin, method: "POST", body: AddRequest(items: [AddInput(trackingNumber: trackingNumber, carrier: carrier?.isEmpty == true ? nil : carrier, name: name.isEmpty ? nil : name, direction: direction.rawValue)])); guard serverURL == origin else { isLoading = false; refresh(); completion(false); return }; isLoading = false; if let failure = result.results.first?.error { errorMessage = failure; completion(false) } else { completion(true); refresh() } }
            catch { guard serverURL == origin else { isLoading = false; refresh(); completion(false); return }; errorMessage = error.localizedDescription; isLoading = false; completion(false) }
        }
    }
    func refreshPackage(_ package: Package) {
        guard isOnline else { errorMessage = "Connect to the server before refreshing."; return }
        isLoading = true
        let origin = serverURL
        Task { [weak self] in
            guard let self else { return }
            do { let envelope: PackageEnvelopeSingle = try await request(path: "/api/v1/packages/\(package.id)/refresh", origin: origin, method: "POST", body: Optional<String>.none); guard serverURL == origin else { isLoading = false; refresh(); return }; let updated = envelope.package; if let index = packages.firstIndex(where: { $0.id == updated.id }) { packages[index] = updated }; defaults.set(try? JSONEncoder().encode(packages), forKey: cacheKey(origin)); lastSynced = Date(); defaults.set(lastSynced, forKey: syncKey(origin)); isLoading = false }
            catch { guard serverURL == origin else { isLoading = false; refresh(); return }; errorMessage = error.localizedDescription; isLoading = false }
        }
    }
    func request<T: Decodable>(path: String, origin: String? = nil) async throws -> T { try await request(path: path, origin: origin ?? serverURL, method: "GET", body: Optional<String>.none) }
    func request<T: Decodable, B: Encodable>(path: String, origin: String, method: String, body: B?) async throws -> T {
        let raw = origin + path
        guard let url = URL(string: raw) else { throw URLError(.badURL) }
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 15; request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(T.self, from: data)
    }
    private func updateLaunchAtLogin() { do { if launchAtLogin { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } } catch { errorMessage = "Could not change launch at login." } }
    func saveServerURL(_ candidate: String) -> Bool {
        guard let url = URL(string: candidate.trimmingCharacters(in: .whitespacesAndNewlines)), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != nil, url.path == "" || url.path == "/", url.query == nil, url.fragment == nil else { errorMessage = "Enter a valid http or https server URL."; return false }
        let normalized = candidate.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/")); if normalized != serverURL { serverURL = normalized; packages = []; lastSynced = defaults.object(forKey: syncKey(normalized)) as? Date; if let data = defaults.data(forKey: cacheKey(normalized)), let saved = try? JSONDecoder().decode([Package].self, from: data) { packages = saved }; isOnline = false; refresh() }; return true
    }
    private func cacheKey(_ origin: String) -> String { "packages.\(origin)" }
    private func syncKey(_ origin: String) -> String { "lastSynced.\(origin)" }
    func quit() { NSApplication.shared.terminate(nil) }
    func openDashboard(_ package: Package? = nil) { var url = serverURL; if let package { url += "/?package=\(package.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? package.id)" }; if let target = URL(string: url) { NSWorkspace.shared.open(target) } }
    var active: [Package] { packages.filter { !$0.archived && $0.status != "delivered" }.sorted { priority($0) < priority($1) } }
    func active(for direction: PackageDirection) -> [Package] { active.filter { ($0.direction ?? PackageDirection.inbound.rawValue) == direction.rawValue } }
    private func priority(_ p: Package) -> Int { switch p.status { case "failure", "error", "return_to_sender": 0; case "out_for_delivery": 1; case "available_for_pickup": 2; case "in_transit": 3; default: 4 } }
}
struct PackageEnvelopeSingle: Codable { let package: Package }

@main struct PostmasterMenuBar: App {
    @StateObject private var store = Store()
    var body: some Scene {
        MenuBarExtra { Popover(store: store).frame(width: 380) } label: { Label("Postmaster", systemImage: store.active.isEmpty ? "shippingbox" : "shippingbox.fill") }.menuBarExtraStyle(.window)
    }
}

struct Popover: View {
    @ObservedObject var store: Store
    @State private var direction: PackageDirection = .inbound
    @State private var showingSettings = false

    private var packages: [Package] { store.active(for: direction) }

    var body: some View {
        Group {
            if showingSettings {
                SettingsView(store: store) { showingSettings = false }
            } else {
                packageList
            }
        }
        .padding(16)
        .fixedSize(horizontal: false, vertical: true)
        .onAppear { store.setPopoverVisible(true) }
        .onDisappear { store.setPopoverVisible(false) }
        .sheet(isPresented: $store.showingAdd) { AddPackageView(store: store, initialDirection: direction) }
    }

    private var packageList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Postmaster").font(.headline)
                Spacer()
                Text("\(packages.count) active").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.bottom, 12)

            Picker("Direction", selection: $direction) {
                ForEach(PackageDirection.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.bottom, 8)

            if packages.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "shippingbox").font(.title2).foregroundStyle(.secondary)
                    Text("No active \(direction.rawValue) packages").font(.subheadline)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(packages.prefix(10))) { package in
                        PackageRow(package: package, refresh: { store.refreshPackage(package) }) {
                            store.openDashboard(package)
                        }
                    }
                }
                if packages.count > 10 {
                    Button("View all \(packages.count) packages") { store.openDashboard() }
                        .buttonStyle(.borderless)
                        .font(.caption)
                        .padding(.vertical, 8)
                }
            }

            if let error = store.errorMessage {
                Text(error).font(.caption).foregroundStyle(.secondary).padding(.top, 8)
            }

            Divider().padding(.vertical, 10)
            HStack(spacing: 16) {
                Button { store.showingAdd = true } label: { Label("Add package", systemImage: "plus") }
                Button("Dashboard") { store.openDashboard() }
                Spacer()
                Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(store.isLoading)
                    .help("Refresh packages")
                    .accessibilityLabel("Refresh packages")
                Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                    .help("Settings")
                    .accessibilityLabel("Settings")
            }
            .font(.caption)
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
        }
    }
}

struct SettingsView: View {
    @ObservedObject var store: Store
    let done: () -> Void
    @State private var draftURL = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Settings").font(.headline)
                Spacer()
                Button("Done", action: done).keyboardShortcut(.cancelAction)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Server URL").font(.caption).foregroundStyle(.secondary)
                HStack {
                    TextField("https://…", text: $draftURL).textFieldStyle(.roundedBorder)
                    Button("Save") {
                        if store.saveServerURL(draftURL) { draftURL = store.serverURL }
                    }
                }
            }
            Toggle("Launch at login", isOn: $store.launchAtLogin).toggleStyle(.checkbox)
            Divider()
            VStack(alignment: .leading, spacing: 4) {
                Text(store.isOnline ? "Connected" : "Offline")
                if let sync = store.lastSynced {
                    Text("Last synced \(PostmasterDates.timestamp(sync))")
                }
                if let error = store.errorMessage { Text(error) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Button("Quit Postmaster") { store.quit() }.buttonStyle(.borderless)
        }
        .onAppear { draftURL = store.serverURL }
    }
}

struct PackageRow: View {
    let package: Package
    let refresh: () -> Void
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                Image(systemName: icon).foregroundStyle(.secondary).frame(width: 20)
                VStack(alignment: .leading, spacing: 4) {
                    Text(package.name.isEmpty ? package.trackingNumber : package.name)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    Text("\(package.carrier.uppercased()) · \(statusText)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if !["delivered", "cancelled"].contains(package.status), let eta = package.eta, let date = PostmasterDates.deliveryDate(eta) {
                    Text("Due \(date)").font(.caption).foregroundStyle(.secondary)
                        .fixedSize()
                }
            }
            .frame(height: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("\(package.name.isEmpty ? package.trackingNumber : package.name) — \(statusText)")
        .contextMenu {
            if let raw = package.carrierTrackingUrl, let url = URL(string: raw) {
                Link("Open carrier tracking", destination: url)
            }
            Button("Open in dashboard", action: open)
            Button("Refresh package", action: refresh)
        }
    }

    private var statusText: String {
        let detail = package.statusDetail
        let value = detail.isEmpty || ["status_update", "unknown"].contains(detail) ? package.status : detail
        return value.replacingOccurrences(of: "_", with: " ").capitalized
    }
    private var icon: String {
        switch package.status {
        case "out_for_delivery": "truck.box"
        case "failure", "error", "return_to_sender": "exclamationmark.triangle"
        case "available_for_pickup": "shippingbox.and.arrow.backward"
        default: "shippingbox"
        }
    }

}

struct AddPackageView: View { @ObservedObject var store: Store; @Environment(\.dismiss) private var dismiss; @State private var number = ""; @State private var name = ""; @State private var carrier = ""; @State private var direction: PackageDirection = .inbound
    init(store: Store, initialDirection: PackageDirection = .inbound) {
        self.store = store
        _direction = State(initialValue: initialDirection)
    }
    var body: some View { VStack(alignment: .leading, spacing: 12) { Text("Add package").font(.headline); Picker("Direction", selection: $direction) { ForEach(PackageDirection.allCases) { Text($0.title).tag($0) } }.pickerStyle(.segmented).labelsHidden(); TextField("Tracking number", text: $number); TextField("Name (optional)", text: $name); Picker("Carrier", selection: $carrier) { Text("Auto detect").tag(""); Text("USPS").tag("usps"); Text("UPS").tag("ups"); Text("FedEx").tag("fedex"); Text("OnTrac").tag("ontrac"); Text("DHL").tag("dhl"); Text("Other carrier").tag("other") }; if let error = store.errorMessage { Text(error).font(.caption).foregroundStyle(.orange) }; HStack { Spacer(); Button("Cancel") { dismiss() }; Button("Add") { store.add(trackingNumber: number.trimmingCharacters(in: .whitespacesAndNewlines), name: name, carrier: carrier, direction: direction) { success in if success { dismiss() } } }.keyboardShortcut(.defaultAction).disabled(number.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isLoading) } }.padding(20).frame(width: 300) }
}
