import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "./repository.js";
import { TrackingService } from "./tracking.js";
import type { Config } from "./config.js";
import { DatabaseSync } from "node:sqlite";

const config = (key = ""): Config => ({
  dbPath: "",
  port: 8765,
  host: "127.0.0.1",
  easypostApiKey: key,
  trackingApiBase: "https://tracking.yufei.dev/api",
  trackingApiToken: "",
  publicUrl: "https://tracker.test",
  ownerLogin: "owner",
  internalToken: "secret",
  imessageRecipient: "+15550001111",
});

test("SQLite packages and inbox dedupe survive restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "postmaster-")),
    path = join(dir, "db.sqlite");
  const first = new Repository(path);
  const p = first.createPackage({
    id: "p1",
    trackingNumber: "9400111111111111111111",
    carrier: "usps",
    name: "Box",
    notificationMode: "milestones",
  });
  assert.equal(p.status, "unknown");
  assert.equal(p.direction, "inbound");
  assert.equal(first.acceptInbound("event-1", { ok: true }), true);
  first.completeInbound("event-1");
  assert.equal(first.acceptInbound("event-1", { ok: true }), false);
  first.close();
  const second = new Repository(path);
  assert.equal(second.getPackage("p1")?.name, "Box");
  second.close();
  rmSync(dir, { recursive: true, force: true });
});

test("legacy schema migrates direction with an inbound default", () => {
  const dir = mkdtempSync(join(tmpdir(), "postmaster-")),
    path = join(dir, "legacy.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations VALUES(2);
    CREATE TABLE packages(
      id TEXT PRIMARY KEY, tracking_number TEXT NOT NULL, carrier TEXT NOT NULL,
      name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unknown', status_detail TEXT NOT NULL DEFAULT '',
      eta TEXT, tracker_id TEXT, notification_mode TEXT NOT NULL DEFAULT 'milestones',
      archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_checked_at TEXT, last_event_at TEXT, next_check_at TEXT, error TEXT,
      baseline_done INTEGER NOT NULL DEFAULT 0, terminal_observed_at TEXT,
      UNIQUE(carrier, tracking_number)
    );
    CREATE TABLE events(id TEXT PRIMARY KEY, package_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
      status TEXT NOT NULL, status_detail TEXT NOT NULL, description TEXT NOT NULL, location TEXT NOT NULL);
    CREATE TABLE outbox(id TEXT PRIMARY KEY, recipient TEXT NOT NULL, body TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
      created_at TEXT NOT NULL, error TEXT, provider_id TEXT);
    CREATE TABLE inbox(id TEXT PRIMARY KEY, payload TEXT NOT NULL, received_at TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO packages(id,tracking_number,carrier,name,created_at,updated_at)
      VALUES('legacy','9400111111111111111111','usps','Legacy','2026-01-01','2026-01-01');
  `);
  db.close();
  const repo = new Repository(path);
  assert.equal(repo.getPackage("legacy")?.direction, "inbound");
  assert.equal(
    (
      repo.db
        .prepare(
          "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
        )
        .get() as any
    ).version,
    5,
  );
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

test("direction validates on create and patch and survives restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "postmaster-")),
    path = join(dir, "direction.sqlite"),
    repo = new Repository(path),
    service = new TrackingService(repo, config());
  const invalid = await service.addPackages([
    { trackingNumber: "9400111111111111111111", direction: "sideways" as any },
  ]);
  assert.match(invalid[0].error ?? "", /Direction/);
  const added = (
    await service.addPackages([
      { trackingNumber: "9400111111111111111111", direction: "outbound" },
    ])
  )[0].package!;
  assert.equal(added.direction, "outbound");
  assert.throws(
    () => service.update(added.id, { direction: "sideways" as any }),
    /Direction/,
  );
  assert.equal(
    service.update(added.id, { direction: "inbound" }).direction,
    "inbound",
  );
  repo.close();
  const reopened = new Repository(path);
  assert.equal(reopened.getPackage(added.id)?.direction, "inbound");
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("EasyPost baseline does not alert, then newly changed milestone does", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, config("key"));
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls++;
    if (init?.method === "POST")
      return new Response(
        JSON.stringify({
          id: "trk-1",
          status: "in_transit",
          tracking_details: [],
        }),
        { status: 200 },
      );
    return new Response(
      JSON.stringify({
        id: "trk-1",
        status: calls > 2 ? "out_for_delivery" : "in_transit",
        status_detail: "moving",
        tracking_details: [],
      }),
      { status: 200 },
    );
  };
  try {
    const added = (
      await service.addPackages([{ trackingNumber: "9400111111111111111111" }])
    )[0].package!;
    assert.equal(added.trackerId, "trk-1");
    await service.refresh(added.id);
    assert.equal(repo.listMessages().length, 0);
    await service.refresh(added.id);
    assert.equal(repo.listMessages().length, 1);
  } finally {
    globalThis.fetch = original;
    repo.close();
  }
});

test("polling HTTP errors preserve last good observation", () => {
  const repo = new Repository(":memory:");
  const p = repo.createPackage(
    {
      id: "p",
      trackingNumber: "1Z9999999999999999",
      carrier: "ups",
      name: "Parcel",
      notificationMode: "detailed",
    },
    { trackerId: "t" },
  );
  repo.saveTracking(p.id, {
    status: "in_transit",
    statusDetail: "moving",
    eta: null,
    events: [],
  });
  const before = repo.getPackage(p.id)!;
  repo.saveTracking(p.id, {
    status: before.status,
    statusDetail: before.statusDetail,
    eta: before.eta,
    events: before.events,
    error: "upstream failed",
  });
  const after = repo.getPackage(p.id)!;
  assert.equal(after.status, "in_transit");
  assert.equal(after.error, "upstream failed");
  assert.equal(after.lastCheckedAt, before.lastCheckedAt);
  repo.close();
});

test("duplicate additions register one tracker and scoped events persist per package", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, config("key"));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        id: "trk-" + calls,
        status: "in_transit",
        tracking_details: [
          {
            datetime: "2026-09-01T12:00:00Z",
            status: "in_transit",
            message: "Arrived",
            tracking_location: { city: "Oakland" },
          },
        ],
      }),
    );
  };
  try {
    const [first, duplicate] = await Promise.all([
      service.addPackages([{ trackingNumber: "9400111111111111111111" }]),
      service.addPackages([{ trackingNumber: "9400111111111111111111" }]),
    ]);
    assert.equal(first[0].package!.id, duplicate[0].package!.id);
    assert.equal(calls, 1);
    const second = (
      await service.addPackages([{ trackingNumber: "9400222222222222222222" }])
    )[0].package!;
    assert.equal(second.events.length, 1);
    assert.equal(repo.getPackage(first[0].package!.id)!.events.length, 1);
  } finally {
    globalThis.fetch = original;
    repo.close();
  }
});

test("terminal polling ends after 24 hours and archived packages do not poll", () => {
  const repo = new Repository(":memory:");
  const p = repo.createPackage({
    id: "terminal",
    trackingNumber: "123456789012",
    carrier: "fedex",
    name: "Box",
    notificationMode: "milestones",
  });
  repo.saveTracking(p.id, {
    status: "delivered",
    statusDetail: "",
    eta: null,
    events: [],
    nextCheckAt: new Date(0).toISOString(),
  });
  assert.equal(repo.duePackages().length, 1);
  assert.equal(
    repo.duePackages(new Date(Date.now() + 25 * 3600000).toISOString()).length,
    0,
  );
  repo.updatePackage(p.id, { archived: true });
  assert.equal(repo.duePackages().length, 0);
  repo.close();
});

test("outbox enqueue is idempotent and incomplete inbound processing can resume", () => {
  const repo = new Repository(":memory:");
  repo.enqueueMessage({
    id: "reply:one",
    recipient: "+15550001111",
    body: "Hello",
  });
  repo.enqueueMessage({
    id: "reply:one",
    recipient: "+15550001111",
    body: "Hello",
  });
  assert.equal(repo.listMessages().length, 1);
  assert.equal(repo.acceptInbound("incoming", { body: "hello" }), true);
  assert.equal(repo.acceptInbound("incoming", { body: "hello" }), true);
  repo.completeInbound("incoming");
  assert.equal(repo.acceptInbound("incoming", {}), false);
  repo.close();
});

test("carrier enrichment of legacy scans stays quiet; new scans and milestones notify once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "postmaster-spam-"));
  const path = join(dir, "db.sqlite");
  let repo = new Repository(path);
  let service = new TrackingService(repo, config("key"));
  const original = globalThis.fetch;
  const scan = {
    datetime: "2026-09-05T16:07:14Z",
    status: "in_transit",
    status_detail: "status_update",
    message: "Prepared for pickup",
    tracking_location: { city: "Erie", state: "PA", country: "US" },
  };
  const latest = {
    ...scan,
    datetime: "2026-09-08T23:44:00Z",
    message: "Arrived at Facility",
  };
  const tracker = {
    id: "trk-spam",
    status: "in_transit",
    status_detail: "arrived_at_facility",
    est_delivery_date: "2026-09-15T00:00:00Z",
    tracking_details: [scan, latest],
  };
  globalThis.fetch = async () => new Response(JSON.stringify(tracker));
  try {
    repo.createPackage(
      {
        id: "spam",
        trackingNumber: "1Z9999999999999999",
        carrier: "usps",
        name: "Box",
        notificationMode: "detailed",
      },
      { trackerId: tracker.id },
    );
    repo.saveTracking("spam", {
      status: tracker.status,
      statusDetail: tracker.status_detail,
      eta: tracker.est_delivery_date,
      events: [latest, scan].map((e, i) => ({
        id: `legacy-location-hash-${i}`,
        occurredAt: e.datetime,
        status: e.status,
        statusDetail: e.status_detail,
        description: e.message,
        location: "",
      })),
    });
    for (let i = 0; i < 3; i++) await service.refresh("spam");
    assert.equal(repo.listMessages().length, 0);
    assert.equal(repo.getPackage("spam")!.events.length, 2);
    assert.equal(repo.getPackage("spam")!.events[1].location, "Erie, PA, US");
    // A newly returned historical scan should update history silently too.
    tracker.tracking_details.push({
      ...scan,
      datetime: "2026-09-04T00:00:00Z",
      message: "Label created",
    });
    await service.refresh("spam");
    assert.equal(repo.listMessages().length, 0);
    tracker.tracking_details.push({
      ...latest,
      datetime: "2026-09-09T01:00:00Z",
      message: "Departed Facility",
    });
    await service.refresh("spam");
    assert.equal(repo.listMessages().length, 1);
    assert.match(repo.listMessages()[0].body, /Departed Facility/);
    repo.close();
    repo = new Repository(path);
    service = new TrackingService(repo, config("key"));
    await service.refresh("spam");
    assert.equal(repo.listMessages().length, 1);
    tracker.status = "out_for_delivery";
    tracker.status_detail = "out_for_delivery";
    await service.refresh("spam");
    await service.refresh("spam");
    assert.equal(repo.listMessages().length, 2);
    tracker.status = "delivered";
    tracker.status_detail = "delivered";
    await service.refresh("spam");
    await service.refresh("spam");
    assert.equal(repo.listMessages().length, 3);
  } finally {
    globalThis.fetch = original;
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("identical tracking alerts are durably deduplicated without suppressing command replies", () => {
  const dir = mkdtempSync(join(tmpdir(), "postmaster-alert-"));
  const path = join(dir, "db.sqlite");
  let repo = new Repository(path);
  try {
    repo.createPackage({
      id: "p",
      trackingNumber: "123456789012",
      carrier: "fedex",
      name: "Box",
      notificationMode: "detailed",
    });
    const observation = {
      status: "in_transit",
      statusDetail: "",
      eta: null,
      events: [],
    };
    repo.saveTracking("p", observation, "Box is moving", "+15550001111");
    repo.close();
    repo = new Repository(path);
    repo.saveTracking("p", observation, "Box is moving", "+15550001111");
    assert.equal(repo.listMessages().length, 1);
    repo.enqueueMessage({
      id: "reply:new-command:0",
      recipient: "+15550001111",
      body: "Box is moving",
    });
    assert.equal(repo.listMessages().length, 2);
    repo.saveTracking("p", observation, "Box delivered", "+15550001111");
    assert.equal(repo.listMessages().length, 3);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EasyPost credential 404 explains setup, backs off, and recovers on manual refresh", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, config("key"));
  const original = globalThis.fetch;
  let configured = false;
  globalThis.fetch = async () =>
    configured
      ? new Response(
          JSON.stringify({
            id: "trk-fedex",
            status: "in_transit",
            tracking_details: [],
          }),
        )
      : new Response(
          JSON.stringify({
            error: {
              code: "CREDENTIALS_NOT_FOUND",
              message: "Credentials not found for the specified carrier",
            },
          }),
          { status: 404 },
        );
  try {
    const started = Date.now();
    const result = (
      await service.addPackages([
        {
          trackingNumber: "9400111899223344556611",
          carrier: "usps",
          name: "Simplehuman",
        },
      ])
    )[0].package!;
    assert.equal(result.carrier, "usps");
    assert.equal(result.trackerId, null);
    assert.match(
      result.error!,
      /EasyPost could not find credentials for USPS tracking/,
    );
    assert.doesNotMatch(result.error!, /404/);
    assert.ok(Date.parse(result.nextCheckAt!) >= started + 3_600_000);
    assert.equal(repo.listMessages().length, 0);
    configured = true;
    const recovered = await service.refresh(result.id);
    assert.equal(recovered.id, result.id);
    assert.equal(recovered.name, "Simplehuman");
    assert.equal(recovered.trackerId, "trk-fedex");
    assert.equal(recovered.status, "in_transit");
    assert.equal(recovered.error, null);
    assert.equal(repo.listMessages().length, 0);
  } finally {
    globalThis.fetch = original;
    repo.close();
  }
});

test("unstructured upstream 404 remains a provider failure", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, config("key"));
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("Not found", { status: 404 });
  try {
    const p = (
      await service.addPackages([{ trackingNumber: "9400111899223344556677" }])
    )[0].package!;
    assert.equal(p.error, "EasyPost request failed (404)");
  } finally {
    globalThis.fetch = original;
    repo.close();
  }
});

test("UPS and FedEx use the tracking API and leave USPS on EasyPost", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, {
    ...config("key"),
    trackingApiToken: "tracking-token",
  });
  const original = globalThis.fetch;
  const requests: Array<{
    url: string;
    authorization: string | null;
    body: unknown;
  }> = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    });
    if (String(url).includes("/tracking/fedex/")) {
      return new Response(
        JSON.stringify({
          carrier: "fedex",
          trackingNumber: "539245284345",
          status: "out_for_delivery",
          estimatedDelivery: "2026-09-22T18:00:00-04:00",
          events: [
            {
              timestamp: "2026-09-21T09:15:00-04:00",
              status: "out_for_delivery",
              description: "On FedEx vehicle for delivery",
              location: "Brooklyn, NY, US",
            },
          ],
        }),
      );
    }
    if (String(url).includes("/tracking/ups/")) {
      return new Response(
        JSON.stringify({
          carrier: "ups",
          trackingNumber: "1Z999AA10123456784",
          status: "in_transit",
          estimatedDelivery: "2026-09-23",
          events: [],
        }),
      );
    }
    return new Response(
      JSON.stringify({
        id: "trk-usps",
        status: "in_transit",
        tracking_details: [],
      }),
    );
  };
  try {
    const fedex = (
      await service.addPackages([
        { trackingNumber: "539245284345", name: "Simplehuman" },
      ])
    )[0].package!;
    assert.equal(fedex.carrier, "fedex");
    assert.equal(fedex.status, "out_for_delivery");
    assert.equal(fedex.eta, "2026-09-22");
    assert.equal(fedex.trackerId, null);
    assert.equal(fedex.error, null);
    assert.equal(fedex.events[0]?.description, "On FedEx vehicle for delivery");
    assert.equal(fedex.events[0]?.location, "Brooklyn, NY, US");
    assert.equal(
      requests[0].url,
      "https://tracking.yufei.dev/api/tracking/fedex/539245284345",
    );
    assert.equal(requests[0].authorization, "Bearer tracking-token");
    const ups = (
      await service.addPackages([
        { trackingNumber: "1Z999AA10123456784", carrier: "ups", name: "Lamp" },
      ])
    )[0].package!;
    assert.equal(ups.carrier, "ups");
    assert.equal(ups.status, "in_transit");
    assert.equal(ups.eta, "2026-09-23");
    assert.equal(ups.trackerId, null);
    assert.equal(
      requests[1].url,
      "https://tracking.yufei.dev/api/tracking/ups/1Z999AA10123456784",
    );
    const usps = (
      await service.addPackages([
        { trackingNumber: "9400111899223344556601", name: "Mail" },
      ])
    )[0].package!;
    assert.equal(usps.carrier, "usps");
    assert.equal(usps.trackerId, "trk-usps");
    assert.equal(
      (requests[2].body as { tracker: { carrier: string } }).tracker.carrier,
      "USPS",
    );
    assert.equal(repo.trackingSpend(), null);
  } finally {
    globalThis.fetch = original;
    repo.close();
  }
});

test("DHL uses the tracking API and spaces checks across the daily budget", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, {
    ...config("key"),
    trackingApiToken: "tracking-token",
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/tracking\/dhl\//);
    const number = String(url).split("/").pop();
    return new Response(
      JSON.stringify({
        carrier: "dhl",
        trackingNumber: number,
        status: "in_transit",
        estimatedDelivery: "2026-09-24",
        events: [],
      }),
    );
  };
  try {
    const first = (
      await service.addPackages([
        { trackingNumber: "1234567890", carrier: "dhl", name: "Parcel" },
      ])
    )[0].package!;
    assert.equal(first.trackerId, null);
    assert.equal(first.status, "in_transit");
    assert.equal(first.eta, "2026-09-24");
    const firstWait = Date.parse(first.nextCheckAt!) - Date.now();
    assert.ok(firstWait >= 420_000 && firstWait < 450_000);
    const second = (
      await service.addPackages([
        { trackingNumber: "1234567891", carrier: "dhl", name: "Second" },
      ])
    )[0].package!;
    const secondWait = Date.parse(second.nextCheckAt!) - Date.now();
    assert.ok(secondWait >= 840_000 && secondWait < 900_000);
    assert.equal(repo.trackingSpend(), null);
  } finally {
    globalThis.fetch = original;
    repo.close();
  }
});

test("DHL budget ignores packages the poller no longer checks", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, {
    ...config("key"),
    trackingApiToken: "tracking-token",
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: "in_transit", events: [] }));
  try {
    for (let i = 0; i < 4; i++) {
      repo.createPackage({
        id: `delivered-${i}`,
        trackingNumber: `900000000${i}`,
        carrier: "dhl",
        name: "Old",
        notificationMode: "milestones",
      });
      repo.saveTracking(`delivered-${i}`, {
        status: "delivered",
        statusDetail: "",
        eta: null,
        events: [],
      });
    }
    repo.db
      .prepare("UPDATE packages SET terminal_observed_at=?")
      .run(new Date(Date.now() - 48 * 3_600_000).toISOString());
    repo.createPackage({
      id: "archived",
      trackingNumber: "9000000009",
      carrier: "dhl",
      name: "Archived",
      notificationMode: "milestones",
    });
    repo.updatePackage("archived", { archived: true });
    assert.equal(repo.pollableCount("dhl"), 0);
    const live = (
      await service.addPackages([
        { trackingNumber: "1234567890", carrier: "dhl", name: "Live" },
      ])
    )[0].package!;
    const wait = Date.parse(live.nextCheckAt!) - Date.now();
    assert.ok(wait >= 420_000 && wait < 450_000, `waited ${wait} ms`);
  } finally {
    globalThis.fetch = original;
    repo.close();
  }
});

test("DHL failures wait for the budget, and unknown DHL numbers wait an hour", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, {
    ...config("key"),
    trackingApiToken: "tracking-token",
  });
  const original = globalThis.fetch;
  let response = () =>
    new Response(JSON.stringify({ message: "Upstream unavailable" }), {
      status: 503,
    });
  globalThis.fetch = async () => response();
  const waitFor = (p: { nextCheckAt: string | null }) =>
    Date.parse(p.nextCheckAt!) - Date.now();
  try {
    const failing = (
      await service.addPackages([
        { trackingNumber: "1234567890", carrier: "dhl", name: "Failing" },
      ])
    )[0].package!;
    assert.equal(failing.error, "Upstream unavailable");
    assert.ok(waitFor(failing) >= 420_000, "DHL failure waits for budget");
    const ups = (
      await service.addPackages([{ trackingNumber: "1Z999AA10123456784" }])
    )[0].package!;
    assert.ok(waitFor(ups) < 90_000, "other carriers keep the short backoff");
    response = () =>
      new Response(JSON.stringify({ message: "Shipment not found" }), {
        status: 404,
      });
    const unknown = (
      await service.addPackages([
        { trackingNumber: "1234567891", carrier: "dhl", name: "New label" },
      ])
    )[0].package!;
    assert.equal(unknown.error, "Shipment not found");
    assert.ok(waitFor(unknown) >= 3_590_000, "DHL 404 waits an hour");
  } finally {
    globalThis.fetch = original;
    repo.close();
  }
});

test("only one DHL check is in flight even when several are due", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, {
    ...config("key"),
    trackingApiToken: "tracking-token",
  });
  const original = globalThis.fetch;
  let inFlight = 0;
  let peak = 0;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight--;
    return new Response(JSON.stringify({ status: "in_transit", events: [] }));
  };
  try {
    for (let i = 0; i < 3; i++)
      repo.createPackage({
        id: `dhl-${i}`,
        trackingNumber: `123456789${i}`,
        carrier: "dhl",
        name: `Parcel ${i}`,
        notificationMode: "milestones",
      });
    repo.db
      .prepare("UPDATE packages SET next_check_at=?")
      .run(new Date(0).toISOString());
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(peak, 1);
    assert.equal(requests, 1);
  } finally {
    await service.stop();
    globalThis.fetch = original;
    repo.close();
  }
});

test("tracking spend counts each tracker once, persists, and reconciles refunds", () => {
  const dir = mkdtempSync(join(tmpdir(), "postmaster-spend-"));
  const path = join(dir, "db.sqlite");
  let repo = new Repository(path);
  const fee = {
    type: "TrackerFee",
    amount: "0.02000",
    charged: true,
    refunded: false,
  };
  try {
    assert.equal(repo.trackingSpend(), null);
    repo.recordTrackerFees("trk-1", [fee]);
    repo.recordTrackerFees("trk-1", [fee]);
    repo.recordTrackerFees("trk-2", [{ ...fee, amount: "0.01000" }]);
    repo.recordTrackerFees("trk-pending", [{ ...fee, charged: false }]);
    assert.deepEqual(
      { ...repo.trackingSpend() },
      { totalMicrousd: 30000, trackers: 3 },
    );
    repo.close();
    repo = new Repository(path);
    repo.recordTrackerFees("trk-1", undefined);
    repo.recordTrackerFees("trk-1", [{ ...fee, amount: "bad" }]);
    assert.equal(repo.trackingSpend()!.totalMicrousd, 30000);
    repo.recordTrackerFees("trk-1", [{ ...fee, refunded: true }]);
    assert.equal(repo.trackingSpend()!.totalMicrousd, 10000);
    repo.recordTrackerFees("trk-pending", [fee]);
    assert.equal(repo.trackingSpend()!.totalMicrousd, 30000);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("carrier timezone enrichment persists without duplicating scans or alerts", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, config("key"));
  const original = globalThis.fetch;
  const scan = {
    datetime: "2026-09-15T19:55:13Z",
    datetime_local: null as string | null,
    status: "delivered",
    message: "DELIVERED",
  };
  const tracker = {
    id: "trk-timezone",
    status: "delivered",
    tracking_details: [scan],
  };
  globalThis.fetch = async () => new Response(JSON.stringify(tracker));
  try {
    const p = (
      await service.addPackages([
        { trackingNumber: "9400111899223344556699", name: "Timezone parcel" },
      ])
    )[0].package!;
    service.update(p.id, { notificationMode: "detailed" });
    assert.equal(p.events[0].occurredAtLocal, null);
    const scanId = p.events[0].id;
    scan.datetime_local = "2026-09-15T19:55:13-07:00";
    const enriched = await service.refresh(p.id);
    assert.equal(enriched.error, null);
    assert.equal(enriched.events.length, 1);
    assert.equal(enriched.events[0].id, scanId);
    assert.equal(enriched.events[0].occurredAtLocal, scan.datetime_local);
    assert.equal(enriched.events[0].occurredAt, scan.datetime);
    assert.equal(repo.listMessages().length, 0);
    // A later incomplete or malformed provider response must not erase the offset.
    for (const value of [null, "invalid", "2026-09-15T19:55:13"]) {
      scan.datetime_local = value;
      const refreshed = await service.refresh(p.id);
      assert.equal(
        refreshed.events[0].occurredAtLocal,
        "2026-09-15T19:55:13-07:00",
      );
      assert.equal(refreshed.events.length, 1);
      assert.equal(repo.listMessages().length, 0);
    }
  } finally {
    globalThis.fetch = original;
    repo.close();
  }
});

test("local carrier ETA wins; legacy midnight estimates normalize without extra alerts", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, config("key"));
  const original = globalThis.fetch;
  const tracker = {
    id: "trk-eta",
    status: "in_transit",
    est_delivery_date: "2026-09-18T00:00:00Z",
    carrier_detail: { est_delivery_date_local: null as string | null },
    tracking_details: [],
  };
  globalThis.fetch = async () => new Response(JSON.stringify(tracker));
  try {
    repo.createPackage(
      {
        id: "eta",
        trackingNumber: "9400111899223344556697",
        carrier: "usps",
        name: "ETA parcel",
        notificationMode: "detailed",
      },
      { trackerId: tracker.id },
    );
    repo.saveTracking("eta", {
      status: "in_transit",
      statusDetail: "",
      eta: tracker.est_delivery_date,
      events: [],
    });
    assert.equal(repo.getPackage("eta")!.eta, "2026-09-18");
    assert.equal((await service.refresh("eta")).eta, "2026-09-18");
    assert.equal(repo.listMessages().length, 0);
    tracker.carrier_detail.est_delivery_date_local = "2026-09-19";
    assert.equal((await service.refresh("eta")).eta, "2026-09-19");
    assert.equal(repo.listMessages().length, 1);
    await service.refresh("eta");
    assert.equal(repo.listMessages().length, 1);
    tracker.carrier_detail.est_delivery_date_local = "not-a-date";
    assert.equal((await service.refresh("eta")).eta, "2026-09-18");
  } finally {
    globalThis.fetch = original;
    repo.close();
  }
});

test("repeated DST clock hour is ordered by offset and notifies the later scan once", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, config("key"));
  const original = globalThis.fetch;
  const first = {
    datetime: "2026-11-01T01:50:00Z",
    datetime_local: "2026-11-01T01:50:00-07:00",
    status: "in_transit",
    message: "Arrived",
  };
  const tracker = {
    id: "trk-dst",
    status: "in_transit",
    tracking_details: [first],
  };
  globalThis.fetch = async () => new Response(JSON.stringify(tracker));
  try {
    const p = (
      await service.addPackages([
        { trackingNumber: "9400111899223344556696", name: "DST parcel" },
      ])
    )[0].package!;
    service.update(p.id, { notificationMode: "detailed" });
    tracker.tracking_details.push({
      datetime: "2026-11-01T01:10:00Z",
      datetime_local: "2026-11-01T01:10:00-08:00",
      status: "in_transit",
      message: "Departed",
    });
    const updated = await service.refresh(p.id);
    assert.equal(updated.events[0].description, "Departed");
    assert.equal(updated.lastEventAt, "2026-11-01T01:10:00Z");
    assert.equal(repo.listMessages().length, 1);
    assert.match(repo.listMessages()[0].body, /Departed/);
    await service.refresh(p.id);
    assert.equal(repo.listMessages().length, 1);
  } finally {
    globalThis.fetch = original;
    repo.close();
  }
});
