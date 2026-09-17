import type { TrackingEvent } from "./types.js";

/** Delivery estimates are carrier calendar dates, not instants to timezone-shift. */
export function deliveryDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value);
  if (!match) return null;
  const day = match[1];
  const timestamp = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === day
    ? day
    : null;
}

/** Reject timezone-free and invalid timestamps instead of using the host timezone. */
export function explicitTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (
    !match ||
    !deliveryDate(match[1]) ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59 ||
    !Number.isFinite(Date.parse(value))
  )
    return null;
  return value;
}

type ScanTime = Pick<TrackingEvent, "occurredAt" | "occurredAtLocal">;
export function scanTimestamp(event: ScanTime): string | null {
  const localized = explicitTimestamp(event.occurredAtLocal);
  if (localized) return localized;
  // EasyPost may attach Z to a carrier wall-clock value. Only an actual
  // numeric offset, or its separate localized field, establishes the instant.
  return /[+-]\d{2}:\d{2}$/.test(event.occurredAt)
    ? explicitTimestamp(event.occurredAt)
    : null;
}

export function formatCalendarDate(value: unknown, locale?: string): string {
  const day = deliveryDate(value);
  return day
    ? new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : "No estimate";
}

export function formatTimestamp(
  value: unknown,
  locale?: string,
  timeZone?: string,
): string {
  const timestamp = explicitTimestamp(value);
  return timestamp
    ? new Date(timestamp).toLocaleString(locale, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
        ...(timeZone ? { timeZone } : {}),
      })
    : "Time unavailable";
}

export function formatScanTime(
  event: ScanTime,
  locale?: string,
  timeZone?: string,
): string {
  const timestamp = scanTimestamp(event);
  if (timestamp) return formatTimestamp(timestamp, locale, timeZone);
  // Format the literal carrier clock without claiming UTC or device-local time.
  const raw = event.occurredAt.replace(/(?:Z|[+-]\d{2}:\d{2})$/, "");
  const wallClock = explicitTimestamp(`${raw}Z`);
  if (!wallClock) return "Time unavailable";
  return (
    new Date(wallClock).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    }) + " · carrier time (timezone unavailable)"
  );
}

export function formatScanDate(
  event: ScanTime,
  locale?: string,
  timeZone?: string,
): string {
  const timestamp = scanTimestamp(event);
  if (timestamp)
    return new Date(timestamp).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      ...(timeZone ? { timeZone } : {}),
    });
  const day = deliveryDate(event.occurredAt);
  return day
    ? `${formatCalendarDate(day, locale)} · carrier date`
    : "Date unavailable";
}

/** Used for ordering only; unknown-zone scans retain their supplied carrier order. */
export function scanSortTime(event: ScanTime): number {
  const value = scanTimestamp(event) ?? explicitTimestamp(event.occurredAt);
  return value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
}
