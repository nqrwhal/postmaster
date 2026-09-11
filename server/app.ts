import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Health, IntegrationHealth } from "../shared/types.js";
import { Repository } from "./repository.js";
import { TrackingService } from "./tracking.js";
import { registerRoutes } from "./routes.js";
import { loadConfig, type Config } from "./config.js";

const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const disabled = (message: string): IntegrationHealth => ({
  configured: false,
  status: "disabled",
  message,
});

export async function createApp(
  config: Config = loadConfig(),
  options: { health?: () => Partial<Health>; logger?: boolean } = {},
) {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 64 * 1024 });
  const repository = new Repository(config.dbPath);
  const tracking = new TrackingService(repository, config);
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (path === "/healthz") return;
    const internal =
      config.internalToken &&
      equal(
        String(request.headers.authorization ?? ""),
        `Bearer ${config.internalToken}`,
      );
    if (
      !internal &&
      config.ownerLogin &&
      request.headers["tailscale-user-login"] !== config.ownerLogin
    ) {
      return reply
        .code(403)
        .send({ error: "Connect through your authorized Tailnet identity." });
    }
    if (path.startsWith("/internal/") && !internal)
      return reply
        .code(403)
        .send({ error: "Internal authentication required" });
    if (!internal && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.origin;
      const allowedOrigin = config.publicUrl
        ? new URL(config.publicUrl).origin
        : `http://${request.headers.host}`;
      if (
        (origin && origin !== allowedOrigin) ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        return reply
          .code(403)
          .send({ error: "Cross-origin changes are not allowed." });
      }
      if (
        !String(request.headers["content-type"] ?? "").startsWith(
          "application/json",
        ) &&
        request.headers["content-length"] !== "0" &&
        request.body !== undefined
      ) {
        return reply.code(415).send({ error: "Use application/json." });
      }
    }
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/api/v1/health", async (): Promise<Health> => {
    const messages = repository.listMessages();
    const integrations = options.health?.() ?? {};
    const health: Health = {
      status: "ok",
      version: "1.0.0",
      easypost: config.easypostApiKey
        ? {
            configured: true,
            status: repository.listPackages(false).some((p) => p.error)
              ? "error"
              : "ok",
            message: repository.listPackages(false).some((p) => p.error)
              ? "Some packages could not be checked"
              : "EasyPost configured",
          }
        : disabled("EasyPost key required"),
      photon: disabled("Photon setup required"),
      assistant: disabled("OpenClaw setup required"),
      pendingNotifications: messages.filter((m) => m.state === "pending")
        .length,
      failedNotifications: messages.filter((m) => m.state === "failed").length,
      ...integrations,
    };
    health.status =
      [health.easypost, health.photon, health.assistant].some(
        (i) => i.status !== "ok",
      ) || health.failedNotifications
        ? "degraded"
        : "ok";
    return health;
  });
  registerRoutes(app, tracking);
  const staticRoot = resolve("dist/web");
  if (existsSync(staticRoot))
    await app.register(fastifyStatic, {
      root: staticRoot,
      wildcard: false,
      index: "index.html",
    });
  app.setNotFoundHandler((req, reply) => {
    if (
      req.method === "GET" &&
      !req.url.startsWith("/api/") &&
      existsSync(staticRoot)
    )
      return reply.sendFile("index.html");
    return reply.code(404).send({ error: "Not found" });
  });
  app.addHook("onClose", async () => {
    await tracking.stop();
    repository.close();
  });
  return { app, repository, tracking, config };
}
