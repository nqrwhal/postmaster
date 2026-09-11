import test from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@photon-ai/advanced-imessage/grpc";
import { Repository } from "../repository.js";
import { TrackingService } from "../tracking.js";
import { loadConfig } from "../config.js";
import { PhotonIntegration, normalizeInbound } from "./photon.js";
import { createInboundHandler } from "./handler.js";

// This is the actual Advanced iMessage content shape: no content.type field.
const providerMessage = {
  guid: "spc-msg-regression",
  isFromMe: false,
  isSystemMessage: false,
  sender: { address: "+15551234567", service: "iMessage" },
  chatGuids: ["any;-;+15551234567"],
  dateCreated: new Date(),
  content: {
    text: "1Z999AA10123456784 desk lamp\n1Z999AA10123456789 headphones",
    attachments: [],
    formatting: [],
    mentions: [],
  },
} as unknown as Message;

test("Advanced iMessage text shape is accepted while echoes and non-iMessage input are rejected", () => {
  assert.equal(
    normalizeInbound(providerMessage)?.body,
    providerMessage.content.text,
  );
  assert.equal(normalizeInbound({ ...providerMessage, isFromMe: true }), null);
  assert.equal(
    normalizeInbound({
      ...providerMessage,
      sender: { address: "+15551234567", service: "SMS" },
    }),
    null,
  );
  assert.equal(
    normalizeInbound({ ...providerMessage, content: { attachments: [{}] } }),
    null,
  );
});

test("real provider shape creates named packages and one durable reply, including concurrent replay", async () => {
  const repo = new Repository(":memory:");
  const tracking = new TrackingService(repo, {
    ...loadConfig({}),
    dbPath: ":memory:",
    imessageRecipient: "+15551234567",
  });
  const integration = new PhotonIntegration(
    { projectId: "test", projectSecret: "test", recipient: "+15551234567" },
    repo,
    createInboundHandler({ baseUrl: "", token: "" }, tracking),
  );
  try {
    await Promise.all([
      integration.receiveMessage(providerMessage),
      integration.receiveMessage(providerMessage),
    ]);
    await integration.receiveMessage(providerMessage);
    assert.deepEqual(
      repo
        .listPackages()
        .map((p) => p.name)
        .sort(),
      ["desk lamp", "headphones"],
    );
    assert.equal(repo.listMessages().length, 1);
    assert.match(repo.listMessages()[0].body, /desk lamp/);
    assert.match(repo.listMessages()[0].body, /headphones/);
    assert.ok(
      repo.db
        .prepare("SELECT completed_at FROM inbox WHERE id=?")
        .get(providerMessage.guid)?.completed_at,
    );
  } finally {
    await tracking.stop();
    repo.close();
  }
});

test("repeated shorthand updates explicit name and direction without creating another tracker", async () => {
  const repo = new Repository(":memory:");
  const tracking = new TrackingService(repo, {
    ...loadConfig({}),
    dbPath: ":memory:",
  });
  repo.createPackage(
    {
      id: "existing",
      trackingNumber: "9300111043900020273157",
      carrier: "usps",
      name: "x300 inbound",
      direction: "outbound",
      notificationMode: "muted",
    },
    { trackerId: "existing-provider-tracker" },
  );
  const handler = createInboundHandler({ baseUrl: "", token: "" }, tracking);
  try {
    await handler(
      {
        id: "new-text",
        senderId: "+15551234567",
        body: "9300111043900020273157 x300 inbound",
      },
      async () => {},
    );
    const pkg = repo.getPackage("existing")!;
    assert.equal(pkg.name, "x300");
    assert.equal(pkg.direction, "inbound");
    assert.equal(pkg.notificationMode, "muted");
    assert.equal(pkg.trackerId, "existing-provider-tracker");
    assert.equal(repo.listPackages().length, 1);
    await handler(
      {
        id: "next-text",
        senderId: "+15551234567",
        body: "9300111043900020273157",
      },
      async () => {},
    );
    assert.equal(repo.getPackage("existing")!.name, "x300");
  } finally {
    await tracking.stop();
    repo.close();
  }
});
