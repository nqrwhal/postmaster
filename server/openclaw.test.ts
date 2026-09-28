import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

// OpenClaw loads index.js; index.ts is its typed source. Both must work.
for (const file of ["index.js", "index.ts"]) {
  test(`OpenClaw tools (${file}) reach the real API, including body-less refresh`, async () => {
    const { PostmasterTools } = await import(
      new URL(`../integrations/openclaw/${file}`, import.meta.url).href
    );
    const { app, repository } = await createApp(
      {
        ...loadConfig({}),
        dbPath: ":memory:",
        ownerLogin: "owner@example.test",
        publicUrl: "https://tracker.example.test",
        internalToken: "internal-test-token",
      },
      { logger: false },
    );
    try {
      repository.createPackage({
        id: "p1",
        trackingNumber: "9400111111111111111111",
        carrier: "usps",
        name: "Box",
        notificationMode: "milestones",
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const { port } = app.server.address() as AddressInfo;
      const tools = new PostmasterTools({
        baseUrl: `http://127.0.0.1:${port}/`,
        internalToken: "internal-test-token",
      });
      assert.equal((await tools.refresh({ id: "p1" })).package.id, "p1");
      assert.equal((await tools.detail({ id: "p1" })).package.name, "Box");
      assert.equal(
        (await tools.edit({ id: "p1", name: "Renamed" })).package.name,
        "Renamed",
      );
      assert.equal(
        (await tools.find({ query: "renamed" })).packages[0].id,
        "p1",
      );
      assert.equal((await tools.archive({ id: "p1" })).package.archived, true);
    } finally {
      await app.close();
    }
  });
}
