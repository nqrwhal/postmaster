/** Barcode values accepted by the package form after local decoding. */
export class BarcodeValueError extends Error {
  readonly code = "invalid-barcode-value";

  constructor(
    message = "The barcode does not contain a usable tracking value.",
  ) {
    super(message);
    this.name = "BarcodeValueError";
  }
}

const uspsLengths = new Set([20, 22, 26, 30, 34]);

/**
 * Normalize a decoded shipping value without turning links or arbitrary text
 * into tracking numbers. Separators commonly printed in labels are removed;
 * the returned value is otherwise the barcode payload in uppercase.
 */
export function normalizeTrackingValue(raw: string): string {
  if (typeof raw !== "string") throw new BarcodeValueError();
  const value = raw.trim();
  if (!value) throw new BarcodeValueError("The barcode is empty.");

  // A URL may contain a tracking number, but extracting it would silently
  // change the user's scanned value and could register an unrelated token.
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^www\./i.test(value))
    throw new BarcodeValueError(
      "This barcode contains a link, not a tracking number.",
    );

  const compact = value.toUpperCase().replace(/[\s-]+/g, "");
  if (!/^[A-Z0-9]+$/.test(compact))
    throw new BarcodeValueError(
      "Only shipping barcode characters are supported.",
    );

  if (/^1Z[0-9A-Z]{16}$/.test(compact)) return compact;

  // IMpb routing prefixes contain 420 and a 5- or 9-digit ZIP. Only
  // strip them when the suffix is an unambiguous USPS tracking payload.
  if (/^420/.test(compact)) {
    const candidates = [compact.slice(8), compact.slice(12)].filter(
      (candidate) =>
        /^9\d+$/.test(candidate) && [20, 22].includes(candidate.length),
    );
    if (/^\d+$/.test(compact) && candidates.length === 1) return candidates[0];
    throw new BarcodeValueError(
      "This routing barcode is not a supported tracking number. Try the tracking barcode or enter the number manually.",
    );
  }
  if (/^\d+$/.test(compact) && uspsLengths.has(compact.length)) return compact;

  // Code 39/Code 128 labels are often carrier-specific alphanumeric values.
  // Keep this broad enough for those formats while bounding scanner noise.
  if (compact.length >= 8 && compact.length <= 40) return compact;
  throw new BarcodeValueError(
    "The barcode length is not a supported tracking format.",
  );
}

export function barcodeErrorMessage(error: unknown): string {
  if (error instanceof BarcodeValueError) return error.message;
  const name = error instanceof DOMException ? error.name.toLowerCase() : "";
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  if (
    name === "notallowederror" ||
    name === "securityerror" ||
    message.includes("permission") ||
    message.includes("notallowed")
  )
    return "Camera access was blocked. Allow camera access in browser settings, then retry or choose a photo.";
  if (
    message.includes("notfound") ||
    message.includes("not supported") ||
    message.includes("media device")
  )
    return "No usable camera is available. You can retry or choose a barcode photo.";
  return "We could not read that barcode. Try better lighting, hold it steady, or choose a clearer photo.";
}
