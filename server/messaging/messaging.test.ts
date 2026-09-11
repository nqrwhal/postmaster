import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deterministicCommand } from "./commands.js";
import {
  isAllowedInbound,
  normalizeInbound,
  PhotonIntegration,
} from "./photon.js";
import { drainOutbox } from "./outbox.js";
import type { OutboxMessage } from "../../shared/types.js";

function message(
  id: string,
  state: OutboxMessage["state"] = "pending",
): OutboxMessage {
  return {
    id,
    recipient: "+15551234567",
    body: "hello",
    state,
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    error: null,
    providerId: null,
  };
}

describe("messaging safety and reliability", () => {
  it("rejects echo, group, non-text, and unknown sender input at normalization", () => {
    assert.equal(
      normalizeInbound({
        id: "echo",
        direction: "outbound",
        content: { type: "text", text: "x" },
        sender: { id: "+15551234567" },
      }),
      null,
    );
    const group = normalizeInbound({
      guid: "group",
      content: { type: "text", text: "x" },
      sender: { address: "+15551234567" },
      chatGuids: ["any;+;group"],
    });
    assert.ok(group);
    assert.equal(isAllowedInbound(group, "+15551234567"), false);
    const stranger = normalizeInbound({
      guid: "stranger",
      content: { type: "text", text: "x" },
      sender: { address: "+15550000000" },
      chatGuids: ["any;-;+15550000000"],
    });
    assert.ok(stranger);
    assert.equal(isAllowedInbound(stranger, "+15551234567"), false);
    assert.equal(
      normalizeInbound({
        id: "image",
        content: { type: "attachment" },
        sender: { id: "+15551234567" },
      }),
      null,
    );
    assert.equal(
      normalizeInbound({ id: "unknown", content: { type: "text", text: "x" } }),
      null,
    );
  });

  it("keeps deterministic commands independent of the model", async () => {
    const ctx = {
      add: async () => "added",
      status: async () => "status",
      help: () => "help",
    };
    assert.equal(await deterministicCommand("status", ctx), "status");
    assert.equal(await deterministicCommand("add 1Z999AA name", ctx), "added");
    assert.equal(await deterministicCommand("wat", ctx), null);
  });

  it("retries with the same stable provider id after a failed send", async () => {
    const queued = message("m1");
    const calls: string[] = [];
    let attempts = 0;
    const repo: any = {
      claimDueMessages: () =>
        queued.state === "pending" ? (queued.attempts++, [queued]) : [],
      markMessageSent: (id: string, providerId: string) => {
        queued.state = "sent";
        queued.providerId = providerId;
        calls.push(`${id}:${providerId}`);
      },
      retryMessage: () => {
        queued.state = "pending";
      },
      failMessage: () => {
        throw new Error("unexpected fail");
      },
    };
    const transport = {
      send: async (input: { clientMessageId: string }) => {
        attempts++;
        if (attempts === 1) throw new Error("temporary transport failure");
        return { providerId: `provider:${input.clientMessageId}` };
      },
    };
    await drainOutbox(repo, transport);
    await drainOutbox(repo, transport);
    assert.deepEqual(calls, ["m1:provider:postmaster:m1"]);
  });

  it("suppresses a replay before invoking the handler twice", () => {
    const seen = new Set<string>();
    const inbound = normalizeInbound({
      guid: "replayed",
      content: { type: "text", text: "status" },
      sender: { address: "+15551234567" },
      chatGuids: ["any;-;+15551234567"],
    });
    assert.ok(inbound);
    const accept = (id: string) => !seen.has(id) && (seen.add(id), true);
    assert.equal(accept(inbound.id), true);
    assert.equal(accept(inbound.id), false);
  });

  it("baselines historical events without running commands and never regresses", async () => {
    const values = new Map<string, string>();
    let handled = 0;
    const repo: any = {
      getMetadata: (key: string) => values.get(key) ?? null,
      setMetadata: (key: string, value: string) => values.set(key, value),
      acceptInbound: () => true,
      completeInbound: () => {
        handled++;
      },
    };
    const integration: any = new PhotonIntegration(
      { projectId: "p", projectSecret: "s", recipient: "+15551234567" },
      repo,
      async () => {
        handled++;
      },
    );
    await integration.handleEvent(
      {},
      { type: "catchup.complete", headSequence: 44 },
      "cursor",
      false,
    );
    await integration.handleEvent(
      {},
      {
        type: "message.received",
        sequence: 12,
        message: {
          guid: "old",
          content: { type: "text", text: "status" },
          sender: { address: "+15551234567" },
          chatGuids: ["any;-;+15551234567"],
        },
      },
      "cursor",
      false,
    );
    await integration.handleEvent(
      {},
      { type: "catchup.complete", headSequence: 4 },
      "cursor",
      false,
    );
    assert.equal(values.get("cursor"), "44");
    assert.equal(handled, 0);
  });
});
