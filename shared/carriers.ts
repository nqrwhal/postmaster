import type { Carrier } from "./types.js";

export const carrierLabels: Record<Carrier, string> = {
  ups: "UPS",
  usps: "USPS",
  fedex: "FedEx",
  ontrac: "OnTrac",
  dhl: "DHL",
  other: "Other carrier",
};
export const supportedCarriers = Object.keys(carrierLabels) as Carrier[];

export function carrierTrackingUrl(
  carrier: string,
  trackingNumber: string,
): string | null {
  const number = encodeURIComponent(trackingNumber);
  switch (carrier.toLowerCase()) {
    case "ups":
      return `https://www.ups.com/track?tracknum=${number}`;
    case "usps":
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${number}`;
    case "fedex":
      return `https://www.fedex.com/fedextrack/?trknbr=${number}`;
    case "ontrac":
      return `https://www.ontrac.com/tracking/?number=${number}`;
    case "dhl":
      return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${number}`;
    default:
      return null;
  }
}

export function easypostTrackingUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "track.easypost.com" &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function easypostCarrier(carrier: Carrier): string | undefined {
  switch (carrier) {
    case "fedex":
      return "FedExDefault";
    case "ontrac":
      return "OnTrac";
    // DHL has multiple divisions. Let EasyPost resolve the tracking number.
    case "dhl":
    case "other":
      return undefined;
    default:
      return carrier.toUpperCase();
  }
}
