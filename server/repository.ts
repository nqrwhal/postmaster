import { carrierTrackingUrl, easypostTrackingUrl } from "../shared/carriers.js";
import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AddPackageInput,
  OutboxMessage,
  Package,
  PackageDirection,
  PackagePatch,
  TrackingEvent,
  TrackingSpend,
} from "../shared/types.js";

export interface NewPackage {
  id: string;
  trackingNumber: string;
  carrier: string;
  name: string;
  notificationMode: string;
  direction?: PackageDirection;
}
export interface MessageInput {
  id?: string;
  recipient: string;
  body: string;
}
export interface InboundPayload {
  [key: string]: unknown;
}

const now = () => new Date().toISOString();
const uuid = () => randomUUID();

export class Repository {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.migrate();
  }
  private migrate() {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)",
    );
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version),0) v FROM schema_migrations")
      .get() as { v: number };
    if (row.v < 1) {
      this.db
        .exec(`CREATE TABLE packages(id TEXT PRIMARY KEY, tracking_number TEXT NOT NULL, carrier TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unknown', status_detail TEXT NOT NULL DEFAULT '', eta TEXT, tracker_id TEXT, notification_mode TEXT NOT NULL DEFAULT 'milestones', archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_checked_at TEXT, last_event_at TEXT, next_check_at TEXT, error TEXT, baseline_done INTEGER NOT NULL DEFAULT 0, UNIQUE(carrier,tracking_number));
        CREATE TABLE events(id TEXT PRIMARY KEY, package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE, occurred_at TEXT NOT NULL, status TEXT NOT NULL, status_detail TEXT NOT NULL, description TEXT NOT NULL, location TEXT NOT NULL, UNIQUE(package_id,occurred_at,status,description));
        CREATE TABLE outbox(id TEXT PRIMARY KEY, recipient TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, error TEXT, provider_id TEXT);
        CREATE TABLE inbox(id TEXT PRIMARY KEY, payload TEXT NOT NULL, received_at TEXT NOT NULL, completed_at TEXT);
        CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX packages_due ON packages(archived,next_check_at); CREATE INDEX outbox_due ON outbox(state,next_attempt_at);`);
      this.db.prepare("INSERT INTO schema_migrations(version) VALUES(1)").run();
    }
    if (row.v < 2) {
      try {
        this.db.exec(
          "ALTER TABLE packages ADD COLUMN terminal_observed_at TEXT",
        );
      } catch {
        /* migration already present */
      }
      this.db
        .prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(2)")
        .run();
    }
    if (row.v < 3) {
      const hasDirection = (
        this.db.prepare("PRAGMA table_info(packages)").all() as Array<{
          name: string;
        }>
      ).some((column) => column.name === "direction");
      if (!hasDirection) {
        this.db.exec(
          "ALTER TABLE packages ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound' CHECK(direction IN ('inbound','outbound'))",
        );
      }
      this.db
        .prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES(3)")
        .run();
    }
    if (row.v < 4) {
      this.db.exec(`CREATE TABLE tracker_spend (
        tracker_id TEXT PRIMARY KEY,
        amount_microusd INTEGER NOT NULL,
        checked_at TEXT NOT NULL
      ); INSERT INTO schema_migrations(version) VALUES(4);`);
    }
  }
  recordTrackerFees(trackerId: string, fees: unknown): void {
    // Store the latest fee snapshot once per tracker, never add it on each poll.
    // Missing or malformed fee data must not erase a previously known charge.
    if (!Array.isArray(fees)) return;
    let amount = 0;
    for (const fee of fees) {
      if (!fee || typeof fee !== "object") return;
      if (fee.type !== "TrackerFee") continue;
      if (
        typeof fee.charged !== "boolean" ||
        typeof fee.refunded !== "boolean" ||
        typeof fee.amount !== "string" ||
        !/^\d+(\.\d{1,6})?$/.test(fee.amount)
      )
        return;
      const [whole, fraction = ""] = fee.amount.split(".");
      const micros =
        Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
      if (!Number.isSafeInteger(micros)) return;
      if (fee.charged && !fee.refunded) amount += micros;
    }
    if (!Number.isSafeInteger(amount)) return;
    this.db
      .prepare(
        `INSERT INTO tracker_spend(tracker_id,amount_microusd,checked_at)
      VALUES(?,?,?) ON CONFLICT(tracker_id) DO UPDATE SET
      amount_microusd=excluded.amount_microusd,checked_at=excluded.checked_at`,
      )
      .run(trackerId, amount, now());
  }
  trackingSpend(): TrackingSpend | null {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_microusd),0) totalMicrousd,
      COUNT(*) trackers FROM tracker_spend`,
      )
      .get() as unknown as TrackingSpend;
    return row.trackers ? row : null;
  }
  close() {
    this.db.close();
  }
  getMetadata(key: string): string | null {
    return (
      (
        this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as
          { value: string } | undefined
      )?.value ?? null
    );
  }
  setMetadata(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  createPackage(
    input: NewPackage,
    tracker?: { trackerId: string; error?: string },
  ): Package {
    const t = now();
    this.db
      .prepare(
        "INSERT INTO packages(id,tracking_number,carrier,name,notification_mode,direction,created_at,updated_at,tracker_id,error,next_check_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        input.id,
        input.trackingNumber,
        input.carrier,
        input.name,
        input.notificationMode,
        input.direction ?? "inbound",
        t,
        t,
        tracker?.trackerId || null,
        tracker?.error ?? null,
        new Date(Date.now() + 60000).toISOString(),
      );
    return this.getPackage(input.id)!;
  }
  getPackage(id: string): Package | null {
    const p = this.db
      .prepare("SELECT * FROM packages WHERE id=?")
      .get(id) as any;
    return p ? this.hydrate(p) : null;
  }
  setTracker(id: string, trackerId: string, error: string | null = null) {
    this.db
      .prepare(
        "UPDATE packages SET tracker_id=?,error=?,next_check_at=?,updated_at=? WHERE id=?",
      )
      .run(trackerId, error, new Date().toISOString(), now(), id);
  }
  listPackages(archived?: boolean): Package[] {
    const rows = this.db
      .prepare(
        archived === undefined
          ? "SELECT * FROM packages ORDER BY created_at DESC"
          : "SELECT * FROM packages WHERE archived=? ORDER BY created_at DESC",
      )
      .all(...(archived === undefined ? [] : [archived ? 1 : 0])) as any[];
    return rows.map((x) => this.hydrate(x));
  }
  updatePackage(id: string, patch: PackagePatch): Package {
    const fields: string[] = [];
    const vals: any[] = [];
    const allowed: Record<string, string> = {
      name: "name",
      notificationMode: "notification_mode",
      archived: "archived",
      direction: "direction",
    };
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in allowed)) throw new Error("invalid patch field");
      fields.push(`${allowed[k]}=?`);
      vals.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
    fields.push("updated_at=?");
    vals.push(now(), id);
    this.db
      .prepare(`UPDATE packages SET ${fields.join(",")} WHERE id=?`)
      .run(...vals);
    return this.getPackage(id)!;
  }
  duePackages(at = now()): Package[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM packages WHERE archived=0 AND next_check_at<=? AND (status NOT IN ('delivered','cancelled') OR datetime(replace(terminal_observed_at,'T',' '))>datetime(?,'-24 hours'))",
        )
        .all(at, at) as any[]
    ).map((x) => this.hydrate(x));
  }
  saveTracking(
    id: string,
    data: {
      status: string;
      statusDetail: string;
      eta: string | null;
      events: TrackingEvent[];
      error?: string | null;
      nextCheckAt?: string;
    },
    alertBody?: string,
    recipient = "",
  ) {
    const t = now();
    this.db.exec("BEGIN");
    try {
      const old = this.getPackage(id)!;
      if (data.error) {
        this.db
          .prepare(
            "UPDATE packages SET error=?,next_check_at=?,updated_at=? WHERE id=?",
          )
          .run(
            data.error,
            data.nextCheckAt ?? new Date(Date.now() + 120000).toISOString(),
            t,
            id,
          );
        this.db.exec("COMMIT");
        return;
      }
      const terminal =
        data.status === "delivered" || data.status === "cancelled";
      this.db
        .prepare(
          "UPDATE packages SET status=?,status_detail=?,eta=?,last_checked_at=?,last_event_at=?,next_check_at=?,error=NULL,updated_at=?,baseline_done=1,terminal_observed_at=CASE WHEN status NOT IN ('delivered','cancelled') AND ? THEN ? WHEN status IN ('delivered','cancelled') THEN terminal_observed_at ELSE NULL END WHERE id=?",
        )
        .run(
          data.status,
          data.statusDetail,
          data.eta,
          t,
          data.events[0]?.occurredAt ?? old.lastEventAt,
          data.nextCheckAt ?? new Date(Date.now() + 60000).toISOString(),
          t,
          terminal ? 1 : 0,
          t,
          id,
        );
      for (const e of data.events)
        this.db
          .prepare(
            "INSERT INTO events(id,package_id,occurred_at,status,status_detail,description,location) VALUES(?,?,?,?,?,?,?) ON CONFLICT(package_id,occurred_at,status,description) DO UPDATE SET status_detail=excluded.status_detail,location=excluded.location",
          )
          .run(
            e.id,
            id,
            e.occurredAt,
            e.status,
            e.statusDetail,
            e.description,
            e.location,
          );
      if (alertBody) {
        // Persist alongside the observation so retries/restarts cannot enqueue
        // consecutive identical alerts. Command replies use their own IDs.
        const key = `tracking.lastAlert:${id}:${recipient}`;
        const fingerprint = createHash("sha256")
          .update(alertBody)
          .digest("hex");
        if (this.getMetadata(key) !== fingerprint) {
          this.enqueueMessage({ recipient, body: alertBody });
          this.setMetadata(key, fingerprint);
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  enqueueMessage(input: MessageInput): OutboxMessage {
    const id = input.id ?? uuid(),
      t = now();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO outbox(id,recipient,body,next_attempt_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(id, input.recipient, input.body, t, t);
    return this.getMessage(id)!;
  }
  getMessage(id: string): OutboxMessage | null {
    const r = this.db.prepare("SELECT * FROM outbox WHERE id=?").get(id) as any;
    return r ? this.message(r) : null;
  }
  claimDueMessages(limit: number): OutboxMessage[] {
    const t = now(),
      rows = this.db
        .prepare(
          "SELECT * FROM outbox WHERE state='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT ?",
        )
        .all(t, limit) as any[];
    for (const r of rows)
      this.db
        .prepare(
          "UPDATE outbox SET attempts=attempts+1,next_attempt_at=? WHERE id=?",
        )
        .run(new Date(Date.now() + 120000).toISOString(), r.id);
    return rows.map((r) => this.message(r));
  }
  listMessages(): OutboxMessage[] {
    return (
      this.db
        .prepare("SELECT * FROM outbox ORDER BY created_at DESC")
        .all() as any[]
    ).map((r) => this.message(r));
  }
  markMessageSent(id: string, providerId: string) {
    this.db
      .prepare(
        "UPDATE outbox SET state='sent',provider_id=?,error=NULL WHERE id=?",
      )
      .run(providerId, id);
  }
  retryMessage(id: string, error: string, retryAt: string) {
    this.db
      .prepare(
        "UPDATE outbox SET state='pending',error=?,next_attempt_at=? WHERE id=?",
      )
      .run(error, retryAt, id);
  }
  failMessage(id: string, error: string) {
    this.db
      .prepare("UPDATE outbox SET state='failed',error=? WHERE id=?")
      .run(error, id);
  }
  acceptInbound(id: string, payload: InboundPayload): boolean {
    const existing = this.db
      .prepare("SELECT completed_at FROM inbox WHERE id=?")
      .get(id) as { completed_at: string | null } | undefined;
    if (existing) return existing.completed_at === null;
    this.db
      .prepare("INSERT INTO inbox(id,payload,received_at) VALUES(?,?,?)")
      .run(id, JSON.stringify(payload), now());
    return true;
  }
  completeInbound(id: string) {
    this.db
      .prepare("UPDATE inbox SET completed_at=? WHERE id=?")
      .run(now(), id);
  }
  private message(r: any): OutboxMessage {
    return {
      id: r.id,
      recipient: r.recipient,
      body: r.body,
      state: r.state,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at,
      createdAt: r.created_at,
      error: r.error,
      providerId: r.provider_id,
    };
  }
  private hydrate(r: any): Package {
    const events = this.db
      .prepare(
        "SELECT id,occurred_at occurredAt,status,status_detail statusDetail,description,location FROM events WHERE package_id=? ORDER BY occurred_at DESC",
      )
      .all(r.id) as unknown as TrackingEvent[];
    return {
      id: r.id,
      trackingNumber: r.tracking_number,
      carrier: r.carrier,
      name: r.name,
      direction: r.direction ?? "inbound",
      status: r.status,
      statusDetail: r.status_detail,
      eta: r.eta,
      trackerId: r.tracker_id,
      carrierTrackingUrl:
        carrierTrackingUrl(r.carrier, r.tracking_number) ??
        easypostTrackingUrl(this.getMetadata(`tracking.publicUrl:${r.id}`)),
      notificationMode: r.notification_mode,
      archived: !!r.archived,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastCheckedAt: r.last_checked_at,
      lastEventAt: r.last_event_at,
      nextCheckAt: r.next_check_at,
      error: r.error,
      events,
    };
  }
}
