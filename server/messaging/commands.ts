import { supportedCarriers } from "../../shared/carriers.js";
import type {
  AddPackageInput,
  Carrier,
  PackageDirection,
} from "../../shared/types.js";

export interface CommandContext {
  add(input: AddPackageInput): Promise<string>;
  status(): Promise<string>;
  help(): string;
}

const usage =
  "Send <tracking number> [name] [inbound|outbound], or use status / help.";
const carriers = new Set<Carrier>(supportedCarriers);
const maxBatchLines = 10;
const maxBatchBodyLength = 4000;
const maxNameLength = 80;

const trackingPattern =
  /^(1Z[A-Z0-9]{16}|[CD][A-Z0-9]{10,29}|\d{10,34})(?:\s+(.+))?$/i;

function parseTrackingLine(line: string): AddPackageInput | null {
  const match = trackingPattern.exec(line.trim());
  if (!match) return null;

  const trackingNumber = match[1];
  const remainder = match[2]?.trim() ?? "";
  if (!remainder) return { trackingNumber };

  const parts = remainder.split(/\s+/);
  const last = parts
    .at(-1)
    ?.toLowerCase()
    .replace(/[.,;]$/, "");
  let direction: PackageDirection | undefined;
  if (last === "inbound" || last === "outbound") {
    direction = last;
    parts.pop();
  }
  let carrier: Carrier | undefined;
  const candidate = parts[0]?.replace(/^\[|\]$/g, "").toLowerCase();
  if (carriers.has(candidate as Carrier)) {
    carrier = candidate as Carrier;
    parts.shift();
  }
  const name = parts.join(" ").trim();
  if (name.length > maxNameLength) return null;
  return {
    trackingNumber,
    ...(carrier ? { carrier } : {}),
    ...(name ? { name } : {}),
    ...(direction ? { direction } : {}),
  };
}

function parseBatch(body: string): AddPackageInput[] | null {
  if (body.length > maxBatchBodyLength) return null;
  let lines = body
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0]?.toLowerCase() === "add") lines = lines.slice(1);
  if (lines.length === 0 || lines.length > maxBatchLines) return null;

  const parsed: AddPackageInput[] = [];
  for (const line of lines) {
    const withoutPrefix = line.replace(/^add\s+/i, "");
    const item = parseTrackingLine(withoutPrefix);
    if (!item) return null;
    parsed.push(item);
  }
  return parsed;
}

async function addBatch(
  items: AddPackageInput[],
  ctx: CommandContext,
): Promise<string> {
  const responses: string[] = [];
  for (const item of items) responses.push(await ctx.add(item));
  const result = responses.join("\n");
  return result.length <= 1200
    ? result
    : `Processed ${items.length} tracking updates.`;
}

export async function deterministicCommand(
  body: string,
  ctx: CommandContext,
): Promise<string | null> {
  const input = body.trim();
  const pasted = parseBatch(body);
  if (pasted) return addBatch(pasted, ctx);
  if (/[\r\n]/.test(body)) return null;

  if (/^(1Z[A-Z0-9]{16}|[CD][A-Z0-9]{10,29}|\d{10,34})$/i.test(input))
    return ctx.add({ trackingNumber: input });
  const [verb, ...rest] = input.split(/\s+/);
  switch (verb.toLowerCase()) {
    case "help":
      return ctx.help() || usage;
    case "status":
      return ctx.status();
    case "add": {
      const trackingNumber = rest.shift();
      if (!trackingNumber) return `Usage: add <tracking number> [name]`;
      const candidate = rest[0]?.toLowerCase();
      const carrier =
        candidate && carriers.has(candidate as Carrier)
          ? (rest.shift()!.toLowerCase() as Carrier)
          : undefined;
      return ctx.add({
        trackingNumber,
        carrier,
        name: rest.join(" ") || undefined,
      });
    }
    default:
      return null;
  }
}
