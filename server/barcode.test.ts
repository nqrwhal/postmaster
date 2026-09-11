import test from "node:test";
import assert from "node:assert/strict";
import {
  BarcodeValueError,
  normalizeTrackingValue,
} from "../web/src/lib/barcode.js";

test("barcode normalization keeps only safe tracking payloads", () => {
  const zip5Plus22 = "42012345" + "9401234567890123456789";
  assert.equal(normalizeTrackingValue(zip5Plus22), "9401234567890123456789");
  const zip9Plus22 = "420123456789" + "9401234567890123456789";
  assert.equal(normalizeTrackingValue(zip9Plus22), "9401234567890123456789");
  assert.throws(
    () => normalizeTrackingValue("https://example.test/9401234567890123456789"),
    BarcodeValueError,
  );
  assert.throws(() => normalizeTrackingValue("abc123"), BarcodeValueError);
  assert.throws(
    () => normalizeTrackingValue("42012345999999999999999999"),
    BarcodeValueError,
  );
});
