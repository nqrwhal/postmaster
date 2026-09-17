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
