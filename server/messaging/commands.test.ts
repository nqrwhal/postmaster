import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deterministicCommand } from "./commands.js";
import type { AddPackageInput } from "../../shared/types.js";

const tracking = "1Z999AA10123456784";

function context() {
  const calls: AddPackageInput[] = [];
  return {
    calls,
    ctx: {
      add: async (input: AddPackageInput) => {
        calls.push(input);
        return `added ${input.name ?? input.trackingNumber}`;
      },
      status: async () => "status",
      help: () => "help",
    },
  };
}

describe("deterministic messaging parser", () => {
  it("adds exact bare tracking numbers", async () => {
    const { calls, ctx } = context();
    assert.equal(
      await deterministicCommand(tracking, ctx),
      `added ${tracking}`,
    );
    assert.deepEqual(calls, [{ trackingNumber: tracking }]);
  });

  it("adds multiline tracking numbers with names and carriers sequentially", async () => {
    const { calls, ctx } = context();
    const body = [
      `${tracking} Alice's shoes`,
      "9400111111111111111111 [usps] office supplies",
      `add ${tracking} ups Bob's books`,
    ].join("\n");
    const result = await deterministicCommand(body, ctx);
    assert.equal(
      result,
      "added Alice's shoes\nadded office supplies\nadded Bob's books",
    );
    assert.deepEqual(calls, [
      { trackingNumber: tracking, name: "Alice's shoes" },
      {
        trackingNumber: "9400111111111111111111",
        carrier: "usps",
        name: "office supplies",
      },
      { trackingNumber: tracking, carrier: "ups", name: "Bob's books" },
    ]);
  });

  it("returns null for mixed text without invoking add", async () => {
    const { calls, ctx } = context();
    assert.equal(
      await deterministicCommand(
        `What is the status of ${tracking}?\n${tracking} box`,
        ctx,
      ),
      null,
    );
    assert.deepEqual(calls, []);
  });

  it("returns null for a batch larger than ten lines", async () => {
    const { calls, ctx } = context();
    const body = Array.from({ length: 11 }, () => tracking).join("\n");
    assert.equal(await deterministicCommand(body, ctx), null);
    assert.deepEqual(calls, []);
  });
});

describe("direction shorthand", () => {
  it("separates a trailing direction from the package name", async () => {
    const { calls, ctx } = context();
    await deterministicCommand("9300111043900020273157 x300 inbound", ctx);
    await deterministicCommand(
      `add ${tracking} ups Camera return OUTBOUND`,
      ctx,
    );
    await deterministicCommand("9300111043900020273157 inbound", ctx);
    assert.deepEqual(calls, [
      {
        trackingNumber: "9300111043900020273157",
        name: "x300",
        direction: "inbound",
      },
      {
        trackingNumber: tracking,
        carrier: "ups",
        name: "Camera return",
        direction: "outbound",
      },
      { trackingNumber: "9300111043900020273157", direction: "inbound" },
    ]);
  });
  it("keeps direction words inside names and preserves per-line directions", async () => {
    const { calls, ctx } = context();
    await deterministicCommand(
      `\n${tracking} inbound logistics\n\n9300111043900020273157 x300 outbound\n`,
      ctx,
    );
    assert.deepEqual(calls, [
      { trackingNumber: tracking, name: "inbound logistics" },
      {
        trackingNumber: "9300111043900020273157",
        name: "x300",
        direction: "outbound",
      },
    ]);
  });
});
