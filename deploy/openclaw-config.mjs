import { mkdirSync, writeFileSync } from "node:fs";

const dir = process.env.OPENCLAW_CONFIG_DIR ?? "/home/node/.openclaw";
mkdirSync(`${dir}/extensions/postmaster`, { recursive: true });
const config = {
  gateway: {
    mode: "local",
    bind: "lan",
    port: 18789,
    auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
    http: { endpoints: { chatCompletions: { enabled: true } } },
  },
  plugins: {
    slots: { memory: "none" },
    allow: ["postmaster"],
    entries: {
      postmaster: {
        enabled: true,
        config: {
          baseUrl:
            process.env.POSTMASTER_INTERNAL_URL ?? "http://postmaster:8765",
          internalToken: "${INTERNAL_TOKEN}",
        },
      },
    },
  },
  models: {
    providers: {
      zai: {
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
        api: "openai-completions",
        apiKey: "${ZAI_API_KEY}",
        models: [
          { id: "glm-5.3-flash", name: "GLM-5.3-Flash", reasoning: true },
        ],
      },
    },
  },
  agents: {
    defaults: { heartbeat: { every: "0m" }, skipBootstrap: true },
    list: [
      {
        id: "postmaster",
        default: true,
        model: { primary: "zai/glm-5.3-flash" },
        tools: {
          allow: [
            "postmaster_add",
            "postmaster_find",
            "postmaster_detail",
            "postmaster_rename",
            "postmaster_edit",
            "postmaster_archive",
            "postmaster_refresh",
            "postmaster_notification_preferences",
          ],
        },
      },
    ],
  },
};
writeFileSync(`${dir}/openclaw.json`, JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
});
