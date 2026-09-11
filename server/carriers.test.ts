import test from "node:test";
import assert from "node:assert/strict";
import {
  carrierTrackingUrl,
  easypostTrackingUrl,
  easypostCarrier,
} from "../shared/carriers.js";
import { Repository } from "./repository.js";
import { TrackingService } from "./tracking.js";
import type { Carrier } from "../shared/types.js";
import { deterministicCommand } from "./messaging/commands.js";

test("carrier links use official sites and safely encode tracking numbers", () => {
  for (const [carrier, host, param] of [
    ["ups", "www.ups.com", "tracknum"],
    ["usps", "tools.usps.com", "tLabels"],
    ["fedex", "www.fedex.com", "trknbr"],
    ["ontrac", "www.ontrac.com", "number"],
    ["dhl", "www.dhl.com", "tracking-id"],
  ]) {
    const url = new URL(carrierTrackingUrl(carrier, "123&redirect=bad/#")!);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, host);
    assert.equal(url.searchParams.get(param), "123&redirect=bad/#");
    assert.equal([...url.searchParams.keys()].length, 1);
  }
  assert.equal(carrierTrackingUrl("unknown", "123"), null);
  assert.equal(
    easypostTrackingUrl("https://track.easypost.com/example"),
    "https://track.easypost.com/example",
  );
  for (const bad of [
    "javascript:alert(1)",
    "https://track.easypost.com.evil.com/x",
    "https://user@track.easypost.com/x",
    "http://track.easypost.com/x",
  ])
    assert.equal(easypostTrackingUrl(bad), null);
});

test("new carrier choices register with correct provider routing and retain fallback links", async () => {
  const repo = new Repository(":memory:");
  const service = new TrackingService(repo, {
    dbPath: "",
    port: 0,
    host: "",
    easypostApiKey: "key",
    publicUrl: "",
    ownerLogin: "",
    internalToken: "",
    imessageRecipient: "",
  });
  const original = globalThis.fetch;
  let carrier: Carrier = "ontrac";
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tracker.carrier, easypostCarrier(carrier));
    return new Response(
      JSON.stringify({
        id: `trk-${carrier}`,
        status: "in_transit",
        public_url: "https://track.easypost.com/example",
        tracking_details: [],
      }),
    );
  };
  try {
    for (carrier of ["ontrac", "dhl", "other"] as Carrier[]) {
      const p = (
        await service.addPackages([{ trackingNumber: "1234567890", carrier }])
      )[0].package!;
      assert.equal(p.carrier, carrier);
      assert.equal(p.error, null);
      assert.equal(
        p.carrierTrackingUrl,
        carrierTrackingUrl(carrier, p.trackingNumber) ??
          "https://track.easypost.com/example",
      );
    }
  } finally {
    globalThis.fetch = original;
    repo.close();
  }
});

test("iMessage shorthand recognizes explicit new carriers", async () => {
  const items: any[] = [];
  const context = {
    add: async (input: any) => {
      items.push(input);
      return "added";
    },
    status: async () => "",
    help: () => "",
  };
  await deterministicCommand("C12345678901234 ontrac Desk inbound", context);
  await deterministicCommand("1234567890 dhl Shoes outbound", context);
  assert.equal(items[0].carrier, "ontrac");
  assert.equal(items[0].name, "Desk");
  assert.equal(items[1].carrier, "dhl");
  assert.equal(items[1].direction, "outbound");
});
