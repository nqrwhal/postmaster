import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

test("Tailnet identity, private API token, and mutation origin boundaries", async () => {
  const { app } = await createApp(
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
    assert.equal((await app.inject("/healthz")).statusCode, 200);
    assert.equal((await app.inject("/api/v1/packages")).statusCode, 403);
    const owner = { "tailscale-user-login": "owner@example.test" };
    assert.equal(
      (await app.inject({ url: "/api/v1/packages", headers: owner }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/v1/packages",
          headers: { authorization: "Bearer internal-test-token" },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/packages",
          headers: { ...owner, origin: "https://evil.example" },
          payload: { items: [] },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/packages",
          headers: { ...owner, origin: "https://tracker.example.test" },
          payload: {},
        })
      ).statusCode,
      400,
    );
    const added = await app.inject({
      method: "POST",
      url: "/api/v1/packages",
      headers: owner,
      payload: {
        items: [{ trackingNumber: "1Z999AA10123456784", name: "Test" }],
      },
    });
    assert.equal(added.statusCode, 200);
    const pkg = added.json().results[0].package;
    assert.equal(pkg.name, "Test");
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/packages/${pkg.id}`,
          headers: owner,
          payload: { tracker_id: "override" },
        })
      ).statusCode,
      400,
    );
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/packages/${pkg.id}`,
      headers: owner,
      payload: { notificationMode: "detailed", name: "Renamed" },
    });
    assert.equal(patch.statusCode, 200);
    assert.equal(patch.json().package.notificationMode, "detailed");
  } finally {
    await app.close();
  }
});
