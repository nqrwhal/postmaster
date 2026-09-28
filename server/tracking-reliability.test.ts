import test from "node:test";
import assert from "node:assert/strict";
import { Repository } from "./repository.js";
import { TrackingService, type TrackingLogger } from "./tracking.js";
import type { Config } from "./config.js";

const config: Config = {
  dbPath: "",
  port: 8765,
  host: "127.0.0.1",
  easypostApiKey: "key",
  trackingApiBase: "https://tracking.yufei.dev/api",
  trackingApiToken: "tracking-token",
  publicUrl: "https://tracker.test",
  ownerLogin: "owner",
  internalToken: "secret",
  imessageRecipient: "+15550001111",
};
const quiet: TrackingLogger = { warn: () => {} };
type ApiEvent = {
  timestamp: string;
  status: string;
  description: string;
  location?: string;
};
function apiResponder() {
  const state: {
    status: string;
    estimatedDelivery: string | null;
    events: ApiEvent[];
  } = { status: "in_transit", estimatedDelivery: null, events: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!String(url).includes("/tracking/"))
      throw new Error(`Unexpected request ${url}`);
    return new Response(JSON.stringify(state));
  };
  return { state, restore: () => (globalThis.fetch = original) };
}
const alerts = (repo: Repository) =>
  repo
    .listMessages()
    .reverse()
    .map((m) => m.body.split("\n")[0]);

test("first tracking API poll replaces EasyPost history without alerting", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, config, quiet);
  const api = apiResponder();
  try {
    repo.createPackage(
      {
        id: "moved",
        trackingNumber: "123456789012",
        carrier: "fedex",
        name: "Box",
        notificationMode: "detailed",
      },
      { trackerId: "trk_easypost" },
    );
    repo.saveTracking("moved", {
      status: "in_transit",
      statusDetail: "arrived_at_facility",
      eta: "2026-09-12",
      events: [
        {
          id: "easypost-arrived",
          occurredAt: "2026-09-10T12:12:37Z",
          occurredAtLocal: "2026-09-10T12:12:37-07:00",
          status: "in_transit",
          statusDetail: "arrived_at_facility",
          description: "Arrived at FedEx location",
          location: "OAKLAND, CA",
        },
        {
          id: "easypost-label",
          occurredAt: "2026-09-09T08:00:00Z",
          occurredAtLocal: null,
          status: "pre_transit",
          statusDetail: "",
          description: "Shipment information sent to FedEx",
          location: "",
        },
      ],
    });
    api.state.estimatedDelivery = "2026-09-12";
    api.state.events = [
      {
        timestamp: "2026-09-10T12:12:37-07:00",
        status: "in_transit",
        description: "Arrived at FedEx location",
        location: "Oakland, CA, US",
      },
      {
        timestamp: "2026-09-09T08:00:00-07:00",
        status: "pre_transit",
        description: "Label created",
      },
    ];
    const rebased = await service.refresh("moved");
    assert.deepEqual(
      rebased.events.map((e) => [e.occurredAt, e.description]),
      [
        ["2026-09-10T12:12:37-07:00", "Arrived at FedEx location"],
        ["2026-09-09T08:00:00-07:00", "Label created"],
      ],
    );
    assert.equal(rebased.statusDetail, "");
    assert.deepEqual(alerts(repo), []);
    await service.refresh("moved");
    assert.equal(repo.getPackage("moved")!.events.length, 2);
    api.state.events.unshift({
      timestamp: "2026-09-11T06:40:00-07:00",
      status: "in_transit",
      description: "Departed FedEx location",
    });
    await service.refresh("moved");
    await service.refresh("moved");
    assert.deepEqual(alerts(repo), ["Box: in transit"]);
    assert.match(repo.listMessages()[0].body, /Departed FedEx location/);
    assert.equal(repo.getPackage("moved")!.events.length, 3);
  } finally {
    api.restore();
    repo.close();
  }
});

test("scans dedupe on instant and description when statuses or formats change", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, config, quiet);
  const api = apiResponder();
  try {
    api.state.events = [
      {
        timestamp: "2026-09-21T09:15:00-04:00",
        status: "in_transit",
        description: "On FedEx vehicle for delivery",
        location: "Brooklyn, NY, US",
      },
    ];
    const p = (
      await service.addPackages([
        { trackingNumber: "539245284345", name: "Lamp" },
      ])
    )[0].package!;
    service.update(p.id, { notificationMode: "detailed" });
    api.state.events[0].status = "out_for_delivery";
    let updated = await service.refresh(p.id);
    assert.equal(updated.events.length, 1);
    assert.equal(updated.events[0].status, "out_for_delivery");
    api.state.events[0].timestamp = "2026-09-21T13:15:00Z";
    api.state.events[0].description = "ON FEDEX VEHICLE  FOR DELIVERY";
    updated = await service.refresh(p.id);
    assert.equal(updated.events.length, 1);
    assert.deepEqual(alerts(repo), []);
  } finally {
    api.restore();
    repo.close();
  }
});

test("a repeated milestone with a new scan alerts again; a flap does not", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, config, quiet);
  const api = apiResponder();
  const scan = (timestamp: string, status: string, description: string) => ({
    timestamp,
    status,
    description,
  });
  try {
    api.state.events = [
      scan("2026-09-21T06:00:00-07:00", "in_transit", "Arrived at facility"),
    ];
    const p = (
      await service.addPackages([
        { trackingNumber: "1Z999AA10123456784", name: "Lamp" },
      ])
    )[0].package!;
    const poll = async (status: string, event?: ApiEvent) => {
      api.state.status = status;
      if (event) api.state.events.unshift(event);
      await service.refresh(p.id);
    };
    await poll(
      "out_for_delivery",
      scan("2026-09-21T09:00:00-07:00", "out_for_delivery", "Out for delivery"),
    );
    await poll(
      "in_transit",
      scan("2026-09-21T18:00:00-07:00", "in_transit", "Delivery attempted"),
    );
    await poll(
      "out_for_delivery",
      scan("2026-09-22T09:00:00-07:00", "out_for_delivery", "Out for delivery"),
    );
    assert.deepEqual(alerts(repo), [
      "Lamp: out for delivery",
      "Lamp: out for delivery",
    ]);
    await poll("in_transit");
    await poll("out_for_delivery");
    assert.equal(repo.listMessages().length, 2);
  } finally {
    api.restore();
    repo.close();
  }
});

test("an empty unknown snapshot keeps the last known tracking", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, config, quiet);
  const api = apiResponder();
  try {
    api.state.status = "delivered";
    api.state.estimatedDelivery = "2026-09-20";
    api.state.events = [
      {
        timestamp: "2026-09-20T14:00:00-07:00",
        status: "delivered",
        description: "Delivered",
      },
    ];
    const p = (
      await service.addPackages([
        { trackingNumber: "1Z999AA10123456784", name: "Lamp" },
      ])
    )[0].package!;
    service.update(p.id, { notificationMode: "detailed" });
    const good = { ...api.state, events: [...api.state.events] };
    Object.assign(api.state, {
      status: "unknown",
      estimatedDelivery: null,
      events: [],
    });
    const kept = await service.refresh(p.id);
    assert.equal(kept.status, "delivered");
    assert.equal(kept.eta, "2026-09-20");
    assert.equal(kept.events.length, 1);
    assert.match(kept.error ?? "", /no tracking data/);
    assert.deepEqual(alerts(repo), []);
    Object.assign(api.state, good);
    const recovered = await service.refresh(p.id);
    assert.equal(recovered.error, null);
    assert.deepEqual(alerts(repo), []);
    Object.assign(api.state, {
      status: "unknown",
      estimatedDelivery: null,
      events: [],
    });
    const fresh = (
      await service.addPackages([{ trackingNumber: "1Z999AA10123456785" }])
    )[0].package!;
    assert.equal(fresh.status, "unknown");
    assert.equal(fresh.error, null);
  } finally {
    api.restore();
    repo.close();
  }
});

test("an unmapped provider status keeps the prior status and is logged", async () => {
  const repo = new Repository(":memory:");
  const warnings: Array<Record<string, unknown>> = [];
  const service = new TrackingService(repo, config, {
    warn: (details) => warnings.push(details),
  });
  const api = apiResponder();
  const original = globalThis.fetch;
  try {
    api.state.events = [
      {
        timestamp: "2026-09-21T06:00:00-07:00",
        status: "in_transit",
        description: "Departed facility",
      },
    ];
    const p = (
      await service.addPackages([
        { trackingNumber: "1Z999AA10123456784", name: "Lamp" },
      ])
    )[0].package!;
    service.update(p.id, { notificationMode: "detailed" });
    api.state.status = "exception";
    const updated = await service.refresh(p.id);
    assert.equal(updated.status, "in_transit");
    assert.deepEqual(alerts(repo), []);
    assert.deepEqual(warnings, [
      { packageId: p.id, carrier: "ups", status: "exception" },
    ]);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "trk-usps",
          status: "in_transit",
          tracking_details: [],
        }),
      );
    const usps = (
      await service.addPackages([{ trackingNumber: "9400111899223344556601" }])
    )[0].package!;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "trk-usps",
          status: "held_at_customs",
          tracking_details: [],
        }),
      );
    assert.equal((await service.refresh(usps.id)).status, "in_transit");
    assert.equal(warnings.length, 2);
  } finally {
    globalThis.fetch = original;
    api.restore();
    repo.close();
  }
});

test("re-adding an archived tracking number restores it to active tracking", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, config, quiet);
  const api = apiResponder();
  try {
    const p = (
      await service.addPackages([{ trackingNumber: "1Z999AA10123456784" }])
    )[0].package!;
    service.update(p.id, { archived: true });
    repo.db
      .prepare("UPDATE packages SET next_check_at=? WHERE id=?")
      .run(new Date(0).toISOString(), p.id);
    assert.equal(repo.duePackages().length, 0);
    const [again] = await service.addPackages([
      { trackingNumber: "1z999aa10123456784" },
    ]);
    assert.equal(again.package?.id, p.id);
    assert.equal(again.package?.archived, false);
    assert.equal(repo.listPackages().length, 1);
    assert.deepEqual(
      repo.duePackages().map((x) => x.id),
      [p.id],
    );
  } finally {
    api.restore();
    repo.close();
  }
});

test("a poller database error is logged instead of becoming an unhandled rejection", async () => {
  const repo = new Repository(":memory:");
  const warnings: string[] = [];
  const service = new TrackingService(repo, config, {
    warn: (_details, message) => warnings.push(message),
  });
  repo.duePackages = () => {
    throw new Error("SQLITE_BUSY: database is locked");
  };
  let unhandled: unknown;
  const onUnhandled = (reason: unknown) => (unhandled = reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled, undefined);
    assert.deepEqual(warnings, ["Tracking poll failed; retrying next tick"]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await service.stop();
    repo.close();
  }
});
