import {
  supportedCarriers,
  carrierLabels,
  easypostCarrier,
  easypostTrackingUrl,
} from "../shared/carriers.js";
import { createHash, randomUUID } from "node:crypto";
import { deliveryDate } from "../shared/dates.js";
import type {
  AddPackageInput,
  AddPackageResult,
  Carrier,
  Package,
  PackagePatch,
  PackageDirection,
  TrackingEvent,
  TrackingStatus,
} from "../shared/types.js";
import { Repository } from "./repository.js";
import type { Config } from "./config.js";

const carriers = supportedCarriers;
const directions: PackageDirection[] = ["inbound", "outbound"];
const statuses: TrackingStatus[] = [
  "unknown",
  "pre_transit",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "available_for_pickup",
  "return_to_sender",
  "failure",
  "cancelled",
  "error",
];
const problems = new Set([
  "address_correction",
  "damaged",
  "delayed",
  "delivery_exception",
  "failure",
  "held",
  "lost",
  "missorted",
  "refused",
  "transit_exception",
  "weather_delay",
]);
const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
function detect(n: string): Carrier | undefined {
  if (/^1Z[0-9A-Z]{16}$/.test(n)) return "ups";
  if (/^\d{20,34}$/.test(n)) return "usps";
  if (/^\d{12,15}$/.test(n)) return "fedex";
}
function status(s: unknown): TrackingStatus {
  return typeof s === "string" && statuses.includes(s as TrackingStatus)
    ? (s as TrackingStatus)
    : "unknown";
}
function failureDelay(attempt: number, retryAfter?: string | null): number {
  const value = Number(retryAfter);
  const retryMs = retryAfter
    ? Number.isFinite(value)
      ? value * 1000
      : Date.parse(retryAfter) - Date.now()
    : 0;
  return Math.max(
    Number.isFinite(retryMs) ? retryMs : 0,
    Math.min(3_600_000, 60_000 * 2 ** Math.min(attempt, 6)),
  );
}
interface Tracker {
  id: string;
  fees?: unknown;
  public_url?: unknown;
  status?: string;
  status_detail?: string;
  est_delivery_date?: string | null;
  carrier_detail?: { est_delivery_date_local?: string | null } | null;
  tracking_details?: Array<{
    datetime?: string;
    datetime_local?: string | null;
    status?: string;
    status_detail?: string;
    message?: string;
    tracking_location?: { city?: string; state?: string; country?: string };
  }>;
}
class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryAfter: string | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export class TrackingService {
  private timer?: NodeJS.Timeout;
  private active = new Map<string, Promise<Package>>();
  private adding = new Map<string, Promise<Package>>();
  private stopped = false;
  constructor(
    public repository: Repository,
    public config: Config,
  ) {}

  async addPackages(items: AddPackageInput[]): Promise<AddPackageResult[]> {
    if (!Array.isArray(items) || items.length > 10)
      throw new Error("Submit at most 10 packages.");
    const out: AddPackageResult[] = [];
    for (const item of items) {
      if (!item || typeof item.trackingNumber !== "string") {
        out.push({ trackingNumber: "", error: "Tracking number is required." });
        continue;
      }
      const n = normalize(item.trackingNumber),
        c = item.carrier ?? detect(n);
      if (n.length < 8 || n.length > 40) {
        out.push({
          trackingNumber: item.trackingNumber,
          error: "Enter a valid tracking number (8–40 characters).",
        });
        continue;
      }
      if (!c || !carriers.includes(c)) {
        out.push({
          trackingNumber: item.trackingNumber,
          error: "Choose a carrier for this tracking number.",
        });
        continue;
      }
      if (
        item.name !== undefined &&
        (typeof item.name !== "string" || item.name.length > 200)
      ) {
        out.push({
          trackingNumber: n,
          error: "Name must be at most 200 characters.",
        });
        continue;
      }
      if (
        item.direction !== undefined &&
        !directions.includes(item.direction)
      ) {
        out.push({
          trackingNumber: n,
          error: "Direction must be inbound or outbound.",
        });
        continue;
      }
      const key = `${c}:${n}`;
      const existing = this.repository
        .listPackages()
        .find((p) => p.carrier === c && p.trackingNumber === n);
      if (existing) {
        out.push({ trackingNumber: n, package: existing });
        continue;
      }
      let job = this.adding.get(key);
      if (!job) {
        job = (async () => {
          // Persist before network work: crashes and repeated requests find the same package.
          const p = this.repository.createPackage({
            id: randomUUID(),
            trackingNumber: n,
            carrier: c,
            name: item.name?.trim() || n,
            notificationMode: "milestones",
            direction: item.direction ?? "inbound",
          });
          if (!this.config.easypostApiKey) {
            this.recordFailure(
              p,
              new Error("EasyPost API key is not configured"),
            );
            return this.repository.getPackage(p.id)!;
          }
          return this.refresh(p.id);
        })();
        this.adding.set(key, job);
      }
      try {
        out.push({ trackingNumber: n, package: await job });
      } catch (e) {
        out.push({
          trackingNumber: n,
          error: e instanceof Error ? e.message : "Could not add package.",
        });
      } finally {
        this.adding.delete(key);
      }
    }
    return out;
  }
  list(archived?: boolean) {
    return this.repository.listPackages(archived);
  }
  get(id: string) {
    return this.repository.getPackage(id);
  }
  update(id: string, patch: PackagePatch) {
    if (!patch || Array.isArray(patch) || typeof patch !== "object")
      throw new Error("Invalid package changes.");
    if (
      Object.keys(patch).some(
        (k) =>
          !["name", "notificationMode", "archived", "direction"].includes(k),
      )
    )
      throw new Error("Invalid patch field.");
    if (
      patch.notificationMode !== undefined &&
      !["milestones", "detailed", "muted"].includes(patch.notificationMode)
    )
      throw new Error("Invalid notification mode.");
    if (
      patch.name !== undefined &&
      (typeof patch.name !== "string" ||
        !patch.name.trim() ||
        patch.name.length > 200)
    )
      throw new Error("Name must be 1–200 characters.");
    if (patch.archived !== undefined && typeof patch.archived !== "boolean")
      throw new Error("Archived must be a boolean.");
    if (patch.direction !== undefined && !directions.includes(patch.direction))
      throw new Error("Direction must be inbound or outbound.");
    if (!this.get(id)) throw new Error("package not found");
    return this.repository.updatePackage(id, patch);
  }
  async refresh(id: string): Promise<Package> {
    const p = this.get(id);
    if (!p) throw new Error("package not found");
    if (p.archived || this.stopped) return p;
    const existing = this.active.get(id);
    if (existing) return existing;
    const promise = this.poll(p).finally(() => this.active.delete(id));
    this.active.set(id, promise);
    return promise;
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.pollDue(), 5_000);
    void this.pollDue();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled(this.active.values());
  }
  private async pollDue() {
    if (!this.config.easypostApiKey || this.stopped) return;
    for (const p of this.repository.duePackages()) {
      if (this.active.size >= 3) break;
      if (!this.active.has(p.id)) void this.refresh(p.id).catch(() => {});
    }
  }
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Tracker> {
    const r = await fetch(`https://api.easypost.com/v2${path}`, {
      method,
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Basic ${Buffer.from(this.config.easypostApiKey + ":").toString("base64")}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      // Carrier setup failures can use HTTP 404 too. Keep the structured code
      // so callers can distinguish them from a missing tracking number.
      const payload = (await r.json().catch(() => null)) as {
        error?: { code?: unknown };
      } | null;
      const code =
        typeof payload?.error?.code === "string" ? payload.error.code : null;
      throw new ProviderError(
        `EasyPost request failed (${r.status})`,
        r.headers.get("retry-after"),
        code,
      );
    }
    const t = (await r.json()) as Tracker;
    if (!t || typeof t.id !== "string")
      throw new Error("EasyPost returned an invalid tracker.");
    return t;
  }
  private recordFailure(p: Package, error: unknown) {
    const key = `poll.failures:${p.id}`,
      count = Number(this.repository.getMetadata(key) ?? 0) + 1;
    this.repository.setMetadata(key, String(count));
    const missingCredentials =
      error instanceof ProviderError && error.code === "CREDENTIALS_NOT_FOUND";
    const carrier = carrierLabels[p.carrier];
    this.repository.saveTracking(p.id, {
      status: p.status,
      statusDetail: p.statusDetail,
      eta: p.eta,
      events: p.events,
      error: missingCredentials
        ? `EasyPost could not find credentials for ${carrier} tracking. Check carrier setup in EasyPost, then refresh this package.`
        : error instanceof Error
          ? error.message
          : "Tracking check failed.",
      nextCheckAt: new Date(
        Date.now() +
          Math.max(
            missingCredentials ? 3_600_000 : 0,
            failureDelay(
              count - 1,
              error instanceof ProviderError ? error.retryAfter : null,
            ),
          ),
      ).toISOString(),
    });
  }
  private async poll(original: Package): Promise<Package> {
    let p = original;
    try {
      if (!this.config.easypostApiKey)
        throw new Error("EasyPost API key is not configured");
      let t: Tracker;
      if (!p.trackerId) {
        t = await this.request("/trackers", "POST", {
          tracker: {
            tracking_code: p.trackingNumber,
            carrier: easypostCarrier(p.carrier),
          },
        });
        this.repository.setTracker(p.id, t.id);
        p = this.get(p.id)!;
      } else
        t = await this.request(`/trackers/${encodeURIComponent(p.trackerId)}`);
      this.repository.recordTrackerFees(t.id, t.fees);
      const publicUrl = easypostTrackingUrl(t.public_url);
      if (publicUrl)
        this.repository.setMetadata(`tracking.publicUrl:${p.id}`, publicUrl);
      const events: TrackingEvent[] = (t.tracking_details ?? [])
        .map((e) => {
          const location = [
            e.tracking_location?.city,
            e.tracking_location?.state,
            e.tracking_location?.country,
          ]
            .filter(Boolean)
            .join(", ");
          return {
            id: createHash("sha256")
              .update(JSON.stringify([p.id, e.datetime, e.status, e.message]))
              .digest("hex"),
            occurredAt: e.datetime ?? "",
            // Keep the raw scan key stable for deduplication. EasyPost can
            // enrich an existing scan with its actual timezone later.
            occurredAtLocal:
              e.datetime_local &&
              /(?:Z|[+-]\d{2}:\d{2})$/.test(e.datetime_local) &&
              Number.isFinite(Date.parse(e.datetime_local))
                ? e.datetime_local
                : null,
            status: e.status ?? "unknown",
            statusDetail: e.status_detail ?? "",
            description: e.message ?? "",
            location,
          };
        })
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      const nextStatus = status(t.status),
        detail = t.status_detail ?? "",
        eta =
          deliveryDate(t.carrier_detail?.est_delivery_date_local) ??
          deliveryDate(t.est_delivery_date);
      const latest = this.get(p.id)!; // User preferences may change during the request.
      const alert = latest.archived
        ? undefined
        : this.alert(latest, nextStatus, detail, eta, events);
      this.repository.saveTracking(
        p.id,
        {
          status: nextStatus,
          statusDetail: detail,
          eta,
          events,
          nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
        },
        alert,
        this.config.imessageRecipient,
      );
      this.repository.setMetadata(`poll.failures:${p.id}`, "0");
    } catch (error) {
      this.recordFailure(p, error);
    }
    return this.get(p.id)!;
  }
  private alert(
    p: Package,
    s: TrackingStatus,
    detail: string,
    eta: string | null,
    events: TrackingEvent[],
  ): string | undefined {
    if (
      !p.lastCheckedAt ||
      p.notificationMode === "muted" ||
      !this.config.imessageRecipient
    )
      return;
    const statusChanged = s !== p.status,
      detailChanged = detail !== p.statusDetail;
    // Match the database's natural scan key, including legacy IDs that hashed
    // location. Carriers enrich old scans; that is not a new tracking event.
    const newEvents = events.filter(
      (e) =>
        (!p.lastEventAt || e.occurredAt >= p.lastEventAt) &&
        !p.events.some(
          (x) =>
            x.occurredAt === e.occurredAt &&
            x.status === e.status &&
            x.description === e.description,
        ),
    );
    if (p.notificationMode === "milestones") {
      const milestone = [
        "out_for_delivery",
        "delivered",
        "available_for_pickup",
        "return_to_sender",
        "failure",
        "error",
      ].includes(s);
      if (
        !(milestone && statusChanged) &&
        !(problems.has(detail) && detailChanged)
      )
        return;
    } else if (
      !statusChanged &&
      !detailChanged &&
      eta === p.eta &&
      !newEvents.length
    )
      return;
    const update =
      p.notificationMode === "detailed" && newEvents[0]
        ? `\n${newEvents[0].description}${newEvents[0].location ? ` · ${newEvents[0].location}` : ""}`
        : "";
    const link = this.config.publicUrl
      ? `\n${this.config.publicUrl}/?package=${encodeURIComponent(p.id)}`
      : "";
    return `${p.name}: ${s.replaceAll("_", " ")}${detail && problems.has(detail) ? ` (${detail.replaceAll("_", " ")})` : ""}${eta ? `\nETA ${eta}` : ""}${update}${link}`;
  }
}
