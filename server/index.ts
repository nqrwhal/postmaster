import { createApp } from "./app.js";
import { PhotonIntegration } from "./messaging/index.js";
import { createInboundHandler } from "./messaging/handler.js";
import type { IntegrationHealth } from "../shared/types.js";

let photon: PhotonIntegration | undefined;
let assistantHealth: IntegrationHealth = {
  configured: false,
  status: "disabled",
  message: "OpenClaw setup required",
};
const instance = await createApp(undefined, {
  health: () => ({
    photon: photon?.health() ?? {
      configured: false,
      status: "disabled",
      message: "Photon setup required",
    },
    assistant: assistantHealth,
  }),
});
const { app, tracking, repository, config } = instance;
const assistantConfig = {
  baseUrl: process.env.OPENCLAW_BASE_URL ?? "",
  token: process.env.OPENCLAW_GATEWAY_TOKEN ?? "",
};
assistantHealth = {
  configured: Boolean(assistantConfig.baseUrl && assistantConfig.token),
  status:
    assistantConfig.baseUrl && assistantConfig.token
      ? "connecting"
      : "disabled",
  message: assistantConfig.baseUrl
    ? "OpenClaw configured"
    : "OpenClaw setup required",
};

photon = new PhotonIntegration(
  {
    projectId: process.env.SPECTRUM_PROJECT_ID ?? "",
    projectSecret: process.env.SPECTRUM_PROJECT_SECRET ?? "",
    recipient: config.imessageRecipient,
  },
  repository,
  createInboundHandler(assistantConfig, tracking),
);
let drainTask: Promise<unknown> | undefined;
let closing = false;
const outboxTimer = setInterval(() => {
  if (drainTask || closing) return;
  drainTask = photon
    ?.drain()
    .catch(() => {
      app.log.warn("Message delivery will retry");
    })
    .finally(() => {
      drainTask = undefined;
    });
}, 5000);
async function checkAssistant() {
  if (!assistantHealth.configured) return;
  try {
    const response = await fetch(`${assistantConfig.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${assistantConfig.token}` },
      signal: AbortSignal.timeout(5000),
    });
    assistantHealth = {
      configured: true,
      status: response.ok ? "ok" : "error",
      message: response.ok
        ? "OpenClaw connected"
        : `OpenClaw returned HTTP ${response.status}`,
    };
  } catch {
    assistantHealth = {
      configured: true,
      status: "error",
      message: "OpenClaw is unreachable",
    };
  }
}
const assistantTimer = setInterval(() => void checkAssistant(), 30000);
let photonStarting = false;
let photonStartTask: Promise<void> | undefined;
async function connectPhoton() {
  if (
    closing ||
    photonStarting ||
    !photon?.health().configured ||
    photon.health().status === "ok"
  )
    return;
  photonStarting = true;
  try {
    photonStartTask = photon.start();
    await photonStartTask;
  } catch {
    photon.connectionFailed();
    app.log.warn("Photon could not connect; will retry");
  } finally {
    photonStarting = false;
  }
}
// The transport manages stream reconnects. This retry covers initial authentication failures.
const photonTimer = setInterval(() => {
  if (
    photon?.health().status === "connecting" ||
    photon?.health().message === "Photon connection failed; retrying"
  )
    void connectPhoton();
}, 30000);
app.addHook("preClose", async () => {
  closing = true;
  clearInterval(outboxTimer);
  clearInterval(assistantTimer);
  clearInterval(photonTimer);
  await photonStartTask?.catch(() => {});
  await drainTask;
  await photon?.stop();
});
await app.listen({ host: config.host, port: config.port });
tracking.start();
void connectPhoton();
void checkAssistant();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
