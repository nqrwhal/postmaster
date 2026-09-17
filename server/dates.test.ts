import test from "node:test";
import assert from "node:assert/strict";
import {
  deliveryDate,
  explicitTimestamp,
  formatCalendarDate,
  formatTimestamp,
  formatScanTime,
  formatScanDate,
  scanSortTime,
} from "../shared/dates.js";

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

test("real timestamps follow DST at both spring and fall transitions", () => {
  for (const [value, expected] of [
    ["2026-03-08T09:30:00Z", /Mar 8.*1:30.*AM PST/],
    ["2026-03-08T10:30:00Z", /Mar 8.*3:30.*AM PDT/],
    ["2026-11-01T08:30:00Z", /Nov 1.*1:30.*AM PDT/],
    ["2026-11-01T09:30:00Z", /Nov 1.*1:30.*AM PST/],
  ] as const) {
    assert.match(
      formatTimestamp(value, "en-US", "America/Los_Angeles"),
      expected,
    );
  }
});

test("scan offsets convert across date boundaries and missing offsets stay explicitly unknown", () => {
  const scan = {
    occurredAt: "2026-09-15T23:55:00Z",
    occurredAtLocal: "2026-09-15T23:55:00-07:00",
  };
  assert.match(
    formatScanTime(scan, "en-US", "America/New_York"),
    /Sep 16.*2:55.*AM EDT/,
  );
  assert.equal(formatScanDate(scan, "en-US", "America/New_York"), "Sep 16");
  const unknown = { occurredAt: scan.occurredAt };
  const a = formatScanTime(unknown, "en-US", "America/Los_Angeles");
  assert.match(a, /Sep 15.*11:55.*PM · carrier time \(timezone unavailable\)/);
  assert.equal(a, formatScanTime(unknown, "en-US", "Asia/Tokyo"));
  assert.equal(formatScanDate(unknown, "en-US"), "Sep 15 · carrier date");
  assert.ok(
    scanSortTime(scan) >
      scanSortTime({ occurredAt: "2026-09-16T05:00:00+00:00" }),
  );
});

test("invalid and timezone-free timestamps never inherit the server or device timezone", () => {
  for (const value of [
    null,
    "",
    "garbage",
    "2026-09-15T19:55:00",
    "2026-02-30T10:00:00Z",
    "2026-09-15T24:00:00Z",
  ]) {
    assert.equal(explicitTimestamp(value), null);
    assert.equal(formatTimestamp(value, "en-US"), "Time unavailable");
  }
  assert.equal(formatScanTime({ occurredAt: "" }), "Time unavailable");
});

test("calendar estimates and device-local timestamps remain correct when device timezone changes", () => {
  const previous = process.env.TZ;
  try {
    for (const zone of [
      "America/Los_Angeles",
      "Asia/Tokyo",
      "Pacific/Kiritimati",
      "Pacific/Honolulu",
    ]) {
      process.env.TZ = zone;
      assert.equal(
        formatCalendarDate("2026-09-18T00:00:00Z", "en-US"),
        "Sep 18",
      );
      assert.equal(formatCalendarDate("2028-02-29", "en-US"), "Feb 29");
    }
    process.env.TZ = "America/Los_Angeles";
    assert.match(
      formatTimestamp("2026-09-18T01:00:00Z", "en-US"),
      /Sep 17.*6:00.*PM PDT/,
    );
    process.env.TZ = "Asia/Tokyo";
    assert.match(
      formatTimestamp("2026-09-18T01:00:00Z", "en-US"),
      /Sep 18.*10:00.*AM/,
    );
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
