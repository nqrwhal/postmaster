import test from "node:test";
import assert from "node:assert/strict";
import { deliveryDate } from "../shared/dates.js";

test("delivery estimates preserve carrier calendar days and reject invalid dates", () => {
  assert.equal(deliveryDate("2026-09-18T00:00:00Z"), "2026-09-18");
  assert.equal(deliveryDate("2026-09-18T23:30:00-07:00"), "2026-09-18");
  assert.equal(deliveryDate("2026-09-18"), "2026-09-18");
  assert.equal(deliveryDate("2028-02-29"), "2028-02-29");
  for (const value of [
    null,
    undefined,
    "",
    "invalid",
    "2026-02-29",
    "2026-13-01",
  ]) {
    assert.equal(deliveryDate(value), null);
  }
});
