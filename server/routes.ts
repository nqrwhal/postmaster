import type { FastifyInstance } from "fastify";
import type { PackagePatch } from "../shared/types.js";
import { TrackingService } from "./tracking.js";
export function registerRoutes(app: FastifyInstance, service: TrackingService) {
  app.get("/api/v1/packages", async (req) => {
    const q = req.query as { archived?: string };
    return {
      spend: service.repository.trackingSpend(),
      packages: service.list(
        q.archived === "true"
          ? true
          : q.archived === "false"
            ? false
            : undefined,
      ),
    };
  });
  app.get("/api/v1/packages/:id", async (req, res) => {
    const p = service.get((req.params as { id: string }).id);
    if (!p) return res.code(404).send({ error: "package not found" });
    return { package: p };
  });
  app.post("/api/v1/packages", async (req, res) => {
    const body = req.body as any;
    if (!body || !Array.isArray(body.items))
      return res.code(400).send({ error: "items must be an array" });
    if (
      body.items.some(
        (x: any) =>
          !x ||
          typeof x.trackingNumber !== "string" ||
          !x.trackingNumber.trim() ||
          x.trackingNumber.length > 80 ||
          !/[A-Za-z0-9]/.test(x.trackingNumber),
      )
    )
      return res
        .code(400)
        .send({ error: "each item needs a valid trackingNumber" });
    return { results: await service.addPackages(body.items) };
  });
  app.patch("/api/v1/packages/:id", async (req, res) => {
    try {
      const body = req.body as any;
      if (!body || typeof body !== "object" || Array.isArray(body))
        return res.code(400).send({ error: "invalid patch" });
      return {
        package: service.update(
          (req.params as { id: string }).id,
          body as PackagePatch,
        ),
      };
    } catch (e) {
      const m = String(e);
      return res
        .code(m.includes("not found") ? 404 : 400)
        .send({ error: m.replace(/^Error: /, "") });
    }
  });
  app.post("/api/v1/packages/:id/refresh", async (req, res) => {
    try {
      return {
        package: await service.refresh((req.params as { id: string }).id),
      };
    } catch (e) {
      return res.code(404).send({ error: String(e).replace(/^Error: /, "") });
    }
  });
  app.get("/api/v1/notifications", async () => ({
    messages: service.repository.listMessages(),
  }));
  app.get("/notifications", async () => ({
    messages: service.repository.listMessages(),
  }));
  app.post("/api/v1/notifications/:id/retry", async (req, res) => {
    const id = (req.params as { id: string }).id;
    if (!service.repository.getMessage(id))
      return res.code(404).send({ error: "message not found" });
    if (service.repository.getMessage(id)?.state === "sent")
      return res.code(409).send({ error: "Message was already sent." });
    service.repository.retryMessage(
      id,
      "manual retry",
      new Date().toISOString(),
    );
    return { message: service.repository.getMessage(id) };
  });
  app.post("/notifications/:id/retry", async (req, res) => {
    const id = (req.params as { id: string }).id;
    if (!service.repository.getMessage(id))
      return res.code(404).send({ error: "message not found" });
    if (service.repository.getMessage(id)?.state === "sent")
      return res.code(409).send({ error: "Message was already sent." });
    service.repository.retryMessage(
      id,
      "manual retry",
      new Date().toISOString(),
    );
    return { message: service.repository.getMessage(id) };
  });
  app.get("/api/v1/export.csv", async (_req, res) => {
    const ps = service.list();
    const esc = (x: string) => `"${x.replaceAll('"', '""')}"`;
    const csv = [
      "name,trackingNumber,carrier,direction,status,eta,archived",
      ...ps.map((p) =>
        [
          p.name,
          p.trackingNumber,
          p.carrier,
          p.direction,
          p.status,
          p.eta ?? "",
          String(p.archived),
        ]
          .map(esc)
          .join(","),
      ),
    ].join("\n");
    return res.type("text/csv").send(csv);
  });
  app.get("/export.csv", async (_req, res) => {
    const ps = service.list();
    const esc = (x: string) => `"${x.replaceAll('"', '""')}"`;
    const csv = [
      "name,trackingNumber,carrier,direction,status,eta,archived",
      ...ps.map((p) =>
        [
          p.name,
          p.trackingNumber,
          p.carrier,
          p.direction,
          p.status,
          p.eta ?? "",
          String(p.archived),
        ]
          .map(esc)
          .join(","),
      ),
    ].join("\n");
    return res.type("text/csv").send(csv);
  });
}
