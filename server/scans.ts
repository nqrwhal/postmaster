import { scanTimestamp } from "../shared/dates.js";
import type { TrackingEvent } from "../shared/types.js";

type Scan = Pick<
  TrackingEvent,
  "occurredAt" | "occurredAtLocal" | "description"
>;

const text = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
const instant = (scan: Scan) => {
  const timestamp = scanTimestamp(scan);
  return timestamp ? Date.parse(timestamp) : null;
};

/**
 * One carrier scan, whichever provider formatted it. Status is not part of
 * the identity: providers remap statuses for scans they already reported.
 */
export function sameScan(a: Scan, b: Scan): boolean {
  if (text(a.description) !== text(b.description)) return false;
  if (a.occurredAt === b.occurredAt) return true;
  const left = instant(a);
  return left !== null && left === instant(b);
}

export function scanIdentity(scan: Scan | undefined): string {
  if (!scan) return "";
  return `${instant(scan) ?? scan.occurredAt}|${text(scan.description)}`;
}
