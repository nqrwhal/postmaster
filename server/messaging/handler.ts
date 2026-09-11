import { OpenClawAssistant, type AssistantConfig } from "./assistant.js";
import type { TrackingService } from "../tracking.js";
import type { InboundHandler } from "./photon.js";

export function createInboundHandler(
  config: AssistantConfig,
  tracking: TrackingService,
): InboundHandler {
  const assistant = new OpenClawAssistant(config, {
    add: async (input) => {
      // Repeated shorthand edits the existing record using only explicit fields.
      const trackingNumber = input.trackingNumber
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      const existing = tracking
        .list()
        .find(
          (p) =>
            p.trackingNumber === trackingNumber &&
            (!input.carrier || p.carrier === input.carrier),
        );
      if (existing) {
        const patch = {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.direction !== undefined
            ? { direction: input.direction }
            : {}),
        };
        const pkg = Object.keys(patch).length
          ? tracking.update(existing.id, patch)
          : existing;
        return `Tracking ${pkg.name} (${pkg.direction}): ${pkg.trackingNumber}.`;
      }
      const [result] = await tracking.addPackages([input]);
      return result.package
        ? `Tracking ${result.package.name} (${result.package.direction}): ${result.package.trackingNumber}. ${result.package.error ?? ""}`
        : (result.error ?? "Could not add package.");
    },
    status: async () => {
      const packages = tracking.list(false);
      return packages.length
        ? packages
            .map(
              (p) =>
                `${p.name}: ${p.status.replaceAll("_", " ")}${p.eta ? `, ETA ${p.eta}` : ""}`,
            )
            .join("\n")
            .slice(0, 1200)
        : "No active packages. Text add <tracking number> to start.";
    },
    help: () =>
      "Send <tracking number> [name] [inbound|outbound], one package per line. For example: 9300111043900020273157 x300 inbound. Commands: status, help.",
  });
  return async (message, reply) => {
    try {
      const result = await assistant.reply(
        message.body,
        `postmaster-${message.senderId}`,
      );
      await reply(result.text);
    } catch {
      await reply(
        "The conversational assistant is unavailable. You can still use add <tracking number> [name], status, or help.",
      );
    }
  };
}
