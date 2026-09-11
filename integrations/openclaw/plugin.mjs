import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { PostmasterTools } from "./index.js";

const id = { type: "string", minLength: 1 };
const object = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const result = async (operation) => {
  const details = await operation;
  return {
    content: [{ type: "text", text: JSON.stringify(details).slice(0, 6000) }],
    details,
  };
};

export default definePluginEntry({
  id: "postmaster",
  name: "Postmaster package tools",
  description: "Manage packages through the authenticated Postmaster API.",
  register(api) {
    const tools = new PostmasterTools({
      baseUrl:
        api.pluginConfig?.baseUrl ?? process.env.POSTMASTER_INTERNAL_URL ?? "",
      internalToken:
        api.pluginConfig?.internalToken ??
        process.env.POSTMASTER_INTERNAL_TOKEN ??
        "",
    });
    api.registerTool({
      name: "postmaster_add",
      description: "Add a package to Postmaster.",
      parameters: object(
        {
          trackingNumber: id,
          carrier: { type: "string" },
          name: { type: "string" },
          direction: { type: "string", enum: ["inbound", "outbound"] },
        },
        ["trackingNumber"],
      ),
      async execute(_id, params) {
        return result(tools.add(params));
      },
    });
    api.registerTool({
      name: "postmaster_edit",
      description: "Edit a package name or inbound/outbound direction.",
      parameters: object(
        {
          id,
          name: { type: "string" },
          direction: { type: "string", enum: ["inbound", "outbound"] },
        },
        ["id"],
      ),
      async execute(_id, params) {
        return result(tools.edit(params));
      },
    });
    api.registerTool({
      name: "postmaster_find",
      description: "Find tracked packages.",
      parameters: object({ query: { type: "string" } }, ["query"]),
      async execute(_id, params) {
        return result(tools.find(params));
      },
    });
    api.registerTool({
      name: "postmaster_detail",
      description: "Get one tracked package.",
      parameters: object({ id }, ["id"]),
      async execute(_id, params) {
        return result(tools.detail(params));
      },
    });
    api.registerTool({
      name: "postmaster_rename",
      description: "Rename one tracked package.",
      parameters: object({ id, name: id }, ["id", "name"]),
      async execute(_id, params) {
        return result(tools.rename(params));
      },
    });
    api.registerTool({
      name: "postmaster_archive",
      description: "Archive one tracked package.",
      parameters: object({ id }, ["id"]),
      async execute(_id, params) {
        return result(tools.archive(params));
      },
    });
    api.registerTool({
      name: "postmaster_refresh",
      description: "Refresh one tracked package now.",
      parameters: object({ id }, ["id"]),
      async execute(_id, params) {
        return result(tools.refresh(params));
      },
    });
    api.registerTool({
      name: "postmaster_notification_preferences",
      description: "Set package notification mode.",
      parameters: object(
        {
          id,
          mode: { type: "string", enum: ["milestones", "detailed", "muted"] },
        },
        ["id", "mode"],
      ),
      async execute(_id, params) {
        return result(tools.notificationPreferences(params));
      },
    });
  },
});
