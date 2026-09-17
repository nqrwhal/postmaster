import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
const dir = mkdtempSync(join(tmpdir(), "postmaster-browser-"));
const { app, repository } = await createApp(
  {
    dbPath: join(dir, "test.sqlite"),
    port: 8877,
    host: "127.0.0.1",
    easypostApiKey: "",
    publicUrl: "http://127.0.0.1:8877",
    ownerLogin: "",
    internalToken: "",
    imessageRecipient: "",
  },
  { logger: false },
);
for (const [
  id,
  trackingNumber,
  carrier,
  name,
  direction,
  status,
  description,
] of [
  [
    "sample-inbound",
    "1Z999AA10123456784",
    "ups",
    "Desk lamp",
    "inbound",
    "in_transit",
    "Departed facility",
  ],
  [
    "sample-delivered",
    "9400111899223856928312",
    "usps",
    "Running shoes",
    "inbound",
    "delivered",
    "Delivered to mailbox",
  ],
  [
    "sample-outbound",
    "123456789012",
    "fedex",
    "Camera return",
    "outbound",
    "pre_transit",
    "Shipping label created",
  ],
] as const) {
  repository.createPackage({
    id,
    trackingNumber,
    carrier,
    name,
    direction,
    notificationMode: "milestones",
  });
  repository.saveTracking(id, {
    status,
    statusDetail: "",
    eta: status === "delivered" ? null : "2026-09-11T00:00:00Z",
    events: [
      {
        id: `${id}-event`,
        occurredAt: "2026-09-08T14:00:00Z",
        occurredAtLocal:
          id === "sample-inbound" ? "2026-09-08T14:00:00-07:00" : null,
        status,
        statusDetail: "",
        description,
        location: "Oakland, CA",
      },
    ],
  });
}
// Simulate a severed network for WebKit, whose automation offline toggle
// can fail the top-level navigation before dispatching to the service worker.
let disconnected = false;
app.post("/test/network-offline", async () => {
  disconnected = true;
  return { ok: true };
});
app.post("/test/network-online", async () => {
  disconnected = false;
  return { ok: true };
});
app.addHook("onRequest", async (request, reply) => {
  if (disconnected && request.url !== "/test/network-online") {
    reply.hijack();
    request.raw.socket.destroy();
  }
});
await app.listen({ port: 8877, host: "127.0.0.1" });
process.on("SIGTERM", () => {
  void app.close().then(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
});
