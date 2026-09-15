import { IconAction, TooltipProvider } from "./components/ui/icon-action";
import {
  carrierLabels as carrierLabel,
  carrierTrackingUrl,
} from "../../shared/carriers";
import {
  lazy,
  Suspense,
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Archive,
  ArchiveRestore,
  Pencil,
  X,
  ChevronRight,
  ChevronDown,
  Ellipsis,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
} from "lucide-react";
import type {
  AddPackageResult,
  Carrier,
  Health,
  NotificationMode,
  Package,
  PackageDirection,
  PackagePatch,
  OutboxMessage,
  TrackingSpend,
} from "../../shared/types";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { registerPwa } from "./lib/pwa";
import "./styles.css";

const BarcodeScanner = lazy(() =>
  import("./components/barcode-scanner").then((m) => ({
    default: m.BarcodeScanner,
  })),
);

const statusLabels: Record<string, string> = {
  unknown: "Awaiting update",
  pre_transit: "Label created",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  available_for_pickup: "Ready for pickup",
  return_to_sender: "Returning to sender",
  failure: "Delivery exception",
  error: "Tracking error",
  cancelled: "Cancelled",
};
const statusText = (status: string) =>
  statusLabels[status] ?? status.replaceAll("_", " ");
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : "No estimate";
const detailTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      message = (await response.json()).error ?? message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

function DirectionPicker({
  value,
  onChange,
  disabled = false,
  label = "Package direction",
}: {
  value: PackageDirection;
  onChange: (value: PackageDirection) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(value) => onChange(value as PackageDirection)}
    >
      <TabsList aria-label={label} className="direction-picker">
        <TabsTrigger disabled={disabled} value="inbound">
          <ArrowDownLeft aria-hidden="true" />
          Inbound
        </TabsTrigger>
        <TabsTrigger disabled={disabled} value="outbound">
          <ArrowUpRight aria-hidden="true" />
          Outbound
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function App() {
  const [packages, setPackages] = useState<Package[]>([]);
  const [spend, setSpend] = useState<TrackingSpend | null>(null);
  const [direction, setDirection] = useState<PackageDirection>("inbound");
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<"manual" | "scan" | null>(null);
  const [utility, setUtility] = useState<"notifications" | "settings" | null>(
    null,
  );
  const [notice, setNotice] = useState("");
  const fetching = useRef(false);
  const load = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const data = await api<{
        packages: Package[];
        spend?: TrackingSpend | null;
      }>("/packages?archived=all");
      setSpend(data.spend ?? null);
      setPackages(data.packages);
      setError("");
      setOnline(true);
    } catch (error) {
      setError(errorText(error));
      setOnline(false);
    } finally {
      setLoading(false);
      fetching.current = false;
    }
  }, []);
  useEffect(() => {
    void load();
    const poll = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 30_000);
    const reconnect = () => void load();
    const offline = () => {
      setOnline(false);
      setError("You're offline. Reconnect to update your packages.");
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("offline", offline);
    return () => {
      clearInterval(poll);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", offline);
    };
  }, [load]);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("package");
    if (id) setSelectedId(id);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const selected = packages.find((p) => p.id === selectedId);
  const filtered = packages.filter(
    (p) =>
      p.archived === archived &&
      (p.direction ?? "inbound") === direction &&
      (status === "all" ||
        p.status === status ||
        (status === "problems" &&
          (p.error ||
            ["failure", "error", "return_to_sender"].includes(p.status)))) &&
      `${p.name} ${p.trackingNumber} ${p.carrier}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
  );
  const replace = (pkg: Package) =>
    setPackages((old) => old.map((p) => (p.id === pkg.id ? pkg : p)));
  async function mutate(id: string, patch: PackagePatch) {
    const data = await api<{ package: Package }>(`/packages/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    replace(data.package);
    setNotice("Package updated");
  }
  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>Postmaster</h1>
        <div className="header-actions">
          <Button
            variant="outline"
            disabled={!online}
            onClick={() => setAddMode("scan")}
          >
            <ScanLine aria-hidden="true" />
            <span>Scan</span>
          </Button>
          <Button aria-label="Add package" onClick={() => setAddMode("manual")}>
            <Plus aria-hidden="true" />
            <span>Add package</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More options">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  setArchived(!archived);
                  setStatus("all");
                }}
              >
                {archived ? "Active packages" : "Archive"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void load();
                }}
              >
                Reload packages
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href="/api/v1/export.csv">Export CSV</a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setUtility("notifications")}>
                Notification history
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setUtility("settings")}>
                Settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {error && (
        <div className="message-banner" role="alert">
          <span>
            {error}
            {packages.length > 0 ? " Showing your last loaded packages." : ""}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}
      <section aria-label={archived ? "Archived packages" : "Packages"}>
        <div className="list-navigation">
          <DirectionPicker
            value={direction}
            onChange={setDirection}
            label="Filter by direction"
          />
          {archived && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setArchived(false)}
            >
              <Archive aria-hidden="true" />
              Archive · Back to active
            </Button>
          )}
        </div>
        <div className="list-toolbar">
          <div className="search-field">
            <Search aria-hidden="true" />
            <Input
              aria-label="Search packages"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search packages…"
            />
          </div>
          <select
            className="select-control status-filter"
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="pre_transit">Label created</option>
            <option value="in_transit">In transit</option>
            <option value="out_for_delivery">Out for delivery</option>
            <option value="delivered">Delivered</option>
            <option value="problems">Needs attention</option>
          </select>
        </div>
        {loading ? (
          <div className="empty-state" role="status">
            Loading packages…
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <h2>
              {query || status !== "all"
                ? "No matching packages"
                : `No ${archived ? "archived " : ""}${direction} packages`}
            </h2>
            <p>
              {query || status !== "all"
                ? "Try a different search or status."
                : archived
                  ? "Archived packages will appear here."
                  : "Scan a shipping label or add a tracking number."}
            </p>
          </div>
        ) : (
          <ul className="package-list" aria-label={`${direction} packages`}>
            {filtered.map((pkg) => (
              <li key={pkg.id}>
                <button
                  className="package-row"
                  onClick={() => setSelectedId(pkg.id)}
                >
                  <div className="package-identity">
                    <span className="package-name">
                      {pkg.name || pkg.trackingNumber}
                    </span>
                    <span className="package-meta">
                      {carrierLabel[pkg.carrier] ?? pkg.carrier}
                      <span aria-hidden="true"> · </span>
                      <span className="tracking-number">
                        {pkg.trackingNumber}
                      </span>
                    </span>
                  </div>
                  <div className="package-progress">
                    <span className="status-badge">
                      {pkg.error ? "Needs attention" : statusText(pkg.status)}
                    </span>
                    <span className="arrival">
                      {pkg.status === "delivered"
                        ? date(pkg.lastEventAt)
                        : pkg.eta
                          ? `Expected ${date(pkg.eta)}`
                          : "Awaiting estimate"}
                    </span>
                  </div>
                  <ChevronRight className="row-chevron" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {spend && (
        <footer
          className="tracking-spend"
          title="Recorded EasyPost tracking fees for packages in Postmaster, including archived packages, after refunds. Updates when tracking data is checked."
        >
          Tracking spend ·{" "}
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
          }).format(spend.totalMicrousd / 1_000_000)}
        </footer>
      )}
      {selected && (
        <Detail
          key={selected.id}
          pkg={selected}
          online={online}
          close={() => {
            setSelectedId(null);
            const url = new URL(location.href);
            url.searchParams.delete("package");
            history.replaceState({}, "", url);
          }}
          mutate={mutate}
          refresh={async () => {
            const data = await api<{ package: Package }>(
              `/packages/${selected.id}/refresh`,
              { method: "POST" },
            );
            replace(data.package);
          }}
        />
      )}
      {addMode && (
        <AddPackage
          initialScan={addMode === "scan"}
          initialDirection={direction}
          online={online}
          close={() => setAddMode(null)}
          done={(added) => {
            setPackages((old) => {
              const merged = new Map(old.map((p) => [p.id, p]));
              for (const pkg of added) merged.set(pkg.id, pkg);
              return [...merged.values()].sort((a, b) =>
                b.createdAt.localeCompare(a.createdAt),
              );
            });
            if (added.length) {
              setDirection(added[0].direction);
              setArchived(false);
              setQuery("");
              setStatus("all");
              setNotice(
                `${added.length === 1 ? "Package" : `${added.length} packages`} added`,
              );
            }
          }}
        />
      )}
      {utility && <Utilities mode={utility} close={() => setUtility(null)} />}
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </main>
  );
}

function AddPackage({
  initialScan,
  initialDirection,
  online,
  close,
  done,
}: {
  initialScan: boolean;
  initialDirection: PackageDirection;
  online: boolean;
  close: () => void;
  done: (packages: Package[]) => void;
}) {
  const [scanning, setScanning] = useState(initialScan);
  const [raw, setRaw] = useState("");
  const [name, setName] = useState("");
  const [carrier, setCarrier] = useState<Carrier | "">("");
  const [direction, setDirection] = useState(initialDirection);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<AddPackageResult[]>([]);
  const [scanned, setScanned] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const numbers = [
      ...new Set(
        raw
          .split(/[\n,;\t]+/)
          .map((n) => n.trim().toUpperCase().replace(/[ -]/g, ""))
          .filter(Boolean),
      ),
    ];
    if (!numbers.length || numbers.some((n) => !/^[A-Z0-9]{8,40}$/.test(n)))
      return setError("Enter a valid tracking number, one per line.");
    if (numbers.length > 10)
      return setError("Add up to 10 tracking numbers at a time.");
    if (!online) return setError("Reconnect before adding packages.");
    setSaving(true);
    try {
      const data = await api<{ results: AddPackageResult[] }>("/packages", {
        method: "POST",
        body: JSON.stringify({
          items: numbers.map((trackingNumber) => ({
            trackingNumber,
            direction,
            ...(name.trim() ? { name: name.trim() } : {}),
            ...(carrier ? { carrier } : {}),
          })),
        }),
      });
      const added = data.results.flatMap((result) =>
        result.package ? [result.package] : [],
      );
      done(added);
      setResults(data.results);
      const unsuccessful = data.results.filter((result) => !result.package);
      if (!unsuccessful.length) close();
      else
        setRaw(unsuccessful.map((result) => result.trackingNumber).join("\n"));
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) close();
      }}
    >
      <DialogContent
        className="package-dialog"
        onOpenAutoFocus={(event) => {
          if (initialScan) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{scanning ? "Scan barcode" : "Add package"}</DialogTitle>
          <DialogDescription>
            {scanning
              ? "Use the tracking barcode on your shipping label."
              : "Track a package you're receiving or sending."}
          </DialogDescription>
        </DialogHeader>
        {scanning ? (
          <Suspense
            fallback={
              <p className="muted" role="status">
                Loading scanner…
              </p>
            }
          >
            <BarcodeScanner
              onClose={() => setScanning(false)}
              onScan={(value) => {
                setRaw((old) =>
                  [
                    ...new Set([...old.split("\n").filter(Boolean), value]),
                  ].join("\n"),
                );
                setScanned(true);
                setScanning(false);
                setError("");
              }}
            />
          </Suspense>
        ) : (
          <form onSubmit={submit} className="package-form">
            <DirectionPicker
              value={direction}
              onChange={setDirection}
              disabled={saving}
            />
            <div className="form-field">
              <div className="field-heading">
                <label htmlFor="tracking-numbers">Tracking number</label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={saving || !online}
                  onClick={() => setScanning(true)}
                >
                  <ScanLine aria-hidden="true" />
                  Scan
                </Button>
              </div>
              <Textarea
                id="tracking-numbers"
                autoFocus={!initialScan}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                value={raw}
                onChange={(event) => setRaw(event.target.value)}
                placeholder="One tracking number per line"
                rows={2}
                disabled={saving}
                required
              />
              {scanned && (
                <p className="field-note" role="status">
                  Barcode captured. Check the number before adding.
                </p>
              )}
            </div>
            <div className="form-field">
              <label htmlFor="package-name">
                Name <span className="muted">(optional)</span>
              </label>
              <Input
                id="package-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. New headphones"
                disabled={saving}
                maxLength={200}
              />
            </div>
            <div className="form-field">
              <label htmlFor="carrier">Carrier</label>
              <select
                id="carrier"
                className="select-control"
                value={carrier}
                onChange={(event) =>
                  setCarrier(event.target.value as Carrier | "")
                }
                disabled={saving}
              >
                <option value="">Auto-detect</option>
                {Object.entries(carrierLabel).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            {results.some((result) => result.error) && (
              <ul className="result-list" aria-label="Add results">
                {results.map((result) => (
                  <li key={result.trackingNumber}>
                    <span className="tracking-number">
                      {result.trackingNumber}
                    </span>
                    <span>{result.package ? "Added" : result.error}</span>
                  </li>
                ))}
              </ul>
            )}
            {(error || !online) && (
              <p className="form-error" role="alert">
                {error || "Reconnect before adding packages."}
              </p>
            )}
            <div className="dialog-actions">
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={close}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !online}>
                {saving ? "Adding…" : "Add package"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Detail({
  pkg,
  online,
  close,
  mutate,
  refresh,
}: {
  pkg: Package;
  online: boolean;
  close: () => void;
  mutate: (id: string, patch: PackagePatch) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const detailRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(pkg.name);
  const [direction, setDirection] = useState<PackageDirection>(
    pkg.direction ?? "inbound",
  );
  const [notificationMode, setNotificationMode] = useState<NotificationMode>(
    pkg.notificationMode,
  );
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  async function run(operation: () => Promise<void>, after?: () => void) {
    setBusy(true);
    setError("");
    try {
      await operation();
      after?.();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || !online;
  const directUrl = carrierTrackingUrl(pkg.carrier, pkg.trackingNumber);
  const trackingUrl = directUrl ?? pkg.carrierTrackingUrl;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="package-dialog detail-dialog"
        ref={detailRef}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          detailRef.current?.focus();
        }}
        showCloseButton={false}
      >
        <DialogHeader>
          <div className="detail-heading-row">
            <div className="detail-name-group">
              <DialogTitle className="detail-package-name">
                {pkg.name || "Package"}
              </DialogTitle>
              <IconAction
                label="Edit package"
                hint="Change name, direction, and notifications"
                disabled={disabled}
                aria-expanded={editing}
                aria-haspopup="dialog"
                onClick={() => {
                  setName(pkg.name);
                  setDirection(pkg.direction ?? "inbound");
                  setNotificationMode(pkg.notificationMode);
                  setError("");
                  setEditing(!editing);
                }}
              >
                <Pencil aria-hidden="true" />
              </IconAction>
            </div>
            <div className="detail-header-actions">
              <IconAction
                label="Refresh tracking"
                hint="Check for the latest carrier updates"
                disabled={disabled || pkg.archived || editing}
                onClick={() =>
                  void run(async () => {
                    setRefreshing(true);
                    try {
                      await refresh();
                    } finally {
                      setRefreshing(false);
                    }
                  })
                }
              >
                <RefreshCw
                  aria-hidden="true"
                  className={refreshing ? "animate-spin" : undefined}
                />
              </IconAction>
              <IconAction
                label={pkg.archived ? "Unarchive package" : "Archive package"}
                hint={
                  pkg.archived
                    ? "Return this shipment to your active list"
                    : "Move to the archive; you can restore it later"
                }
                disabled={disabled || editing}
                onClick={() =>
                  void run(
                    () => mutate(pkg.id, { archived: !pkg.archived }),
                    close,
                  )
                }
              >
                {pkg.archived ? (
                  <ArchiveRestore aria-hidden="true" />
                ) : (
                  <Archive aria-hidden="true" />
                )}
              </IconAction>
              <IconAction
                label="Close"
                hint="Return to your package list"
                onClick={close}
              >
                <X aria-hidden="true" />
              </IconAction>
            </div>
          </div>
          <DialogDescription className="tracking-description">
            {carrierLabel[pkg.carrier] ?? pkg.carrier} ·{" "}
            {trackingUrl ? (
              <a
                className="tracking-number tracking-link"
                href={trackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${pkg.trackingNumber} — track on ${directUrl ? (carrierLabel[pkg.carrier] ?? pkg.carrier) : "EasyPost"} (opens in new tab)`}
              >
                {pkg.trackingNumber}
                <span className="tracking-link-arrow" aria-hidden="true">
                  {" "}
                  ↗
                </span>
              </a>
            ) : (
              <span className="tracking-number">{pkg.trackingNumber}</span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="detail-summary">
          <span className="status-badge">{statusText(pkg.status)}</span>
          <span className="muted">
            {pkg.status === "delivered"
              ? "Delivered"
              : `Expected ${date(pkg.eta)}`}
          </span>
        </div>
        {pkg.error && (
          <p className="message-banner" role="alert">
            {pkg.error}
          </p>
        )}
        <Dialog
          open={editing}
          onOpenChange={(open) => {
            if (busy) return;
            setEditing(open);
            if (!open) setError("");
          }}
        >
          <DialogContent
            className="package-dialog package-editor-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              detailRef.current
                ?.querySelector<HTMLButtonElement>(
                  '[aria-label="Edit package"]',
                )
                ?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>Edit package</DialogTitle>
              <DialogDescription className="sr-only">
                Change the name, direction, and notifications for this shipment.
              </DialogDescription>
            </DialogHeader>
            <form
              className="package-edit-panel"
              aria-label="Edit package"
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim()) return;
                void run(
                  () =>
                    mutate(pkg.id, {
                      name: name.trim(),
                      direction,
                      notificationMode,
                    }),
                  () => setEditing(false),
                );
              }}
            >
              <div className="form-field">
                <label htmlFor="rename-package">Package name</label>
                <Input
                  id="rename-package"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={200}
                  disabled={disabled}
                />
              </div>
              <div className="detail-fields">
                <div className="form-field">
                  <label>Direction</label>
                  <DirectionPicker
                    value={direction}
                    disabled={disabled}
                    onChange={setDirection}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="notification-mode">Notifications</label>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        id="notification-mode"
                        aria-label="Notifications"
                        variant="outline"
                        className="notification-select"
                        disabled={disabled}
                      >
                        <span>
                          {
                            {
                              milestones: "Milestones",
                              detailed: "Every update",
                              muted: "Muted",
                            }[notificationMode]
                          }
                        </span>
                        <ChevronDown aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      className="notification-menu"
                      align="start"
                      sideOffset={6}
                      collisionPadding={16}
                    >
                      <DropdownMenuRadioGroup
                        value={notificationMode}
                        onValueChange={(value) =>
                          setNotificationMode(value as NotificationMode)
                        }
                      >
                        <DropdownMenuRadioItem value="milestones">
                          Milestones
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="detailed">
                          Every update
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="muted">
                          Muted
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <div className="dialog-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setError("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  type="submit"
                  disabled={disabled || !name.trim()}
                >
                  Save changes
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
        {!trackingUrl && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void run(() => navigator.clipboard.writeText(pkg.trackingNumber))
            }
          >
            Copy tracking number
          </Button>
        )}
        {error && !editing && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <section className="timeline">
          <h3>Tracking history</h3>
          {pkg.events.length ? (
            <ol>
              {pkg.events.map((event) => (
                <li key={event.id}>
                  <p>{event.description || statusText(event.status)}</p>
                  {event.location && <p className="muted">{event.location}</p>}
                  <time dateTime={event.occurredAt}>
                    {detailTime(event.occurredAt)}
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No tracking updates yet.</p>
          )}
        </section>
        {pkg.lastCheckedAt && (
          <p className="field-note">Checked {detailTime(pkg.lastCheckedAt)}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Utilities({
  mode,
  close,
}: {
  mode: "notifications" | "settings";
  close: () => void;
}) {
  const [health, setHealth] = useState<Health | null>(null);
  const [messages, setMessages] = useState<OutboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      if (mode === "settings") setHealth(await api<Health>("/health"));
      else
        setMessages(
          (await api<{ messages: OutboxMessage[] }>("/notifications")).messages,
        );
    } catch (error) {
      setError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [mode]);
  useEffect(() => {
    void load();
  }, [load]);
  async function retry(id: string) {
    setRetrying(id);
    setError("");
    try {
      await api(`/notifications/${id}/retry`, { method: "POST" });
      await load();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setRetrying(null);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="package-dialog">
        <DialogHeader>
          <DialogTitle>
            {mode === "settings" ? "Settings" : "Notification history"}
          </DialogTitle>
          <DialogDescription>
            {mode === "settings"
              ? "Your connections and mobile app."
              : "Delivery of your iMessage updates."}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {loading ? (
          <p role="status" className="muted">
            Loading…
          </p>
        ) : mode === "settings" ? (
          <>
            <div className="connection-list">
              {health &&
                (
                  [
                    ["EasyPost", health.easypost],
                    ["iMessage", health.photon],
                    ["Assistant", health.assistant],
                  ] as const
                ).map(([label, state]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <span className="muted">
                      {state.status === "ok" ? "Connected" : state.message}
                    </span>
                  </div>
                ))}
            </div>
            <div className="install-note">
              <h3>On your iPhone</h3>
              <p>
                Open this page in Safari while connected to Tailscale. Tap
                Share, then Add to Home Screen.
              </p>
              <p>Keep Tailscale connected to view and update packages.</p>
            </div>
          </>
        ) : messages.length ? (
          <ul className="notification-list">
            {messages.map((message) => (
              <li key={message.id}>
                <div className="field-heading">
                  <strong>
                    {message.state === "sent"
                      ? "Sent"
                      : message.state === "failed"
                        ? "Delivery failed"
                        : "Pending"}
                  </strong>
                  {message.state === "failed" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={retrying !== null}
                      onClick={() => void retry(message.id)}
                    >
                      {retrying === message.id ? "Retrying…" : "Retry"}
                    </Button>
                  )}
                </div>
                <p>{message.body}</p>
                <time dateTime={message.createdAt}>
                  {detailTime(message.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No notifications yet.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={450} skipDelayDuration={0}>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
registerPwa();
