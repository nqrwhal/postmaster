import test from "node:test";
import assert from "node:assert/strict";
import { OpenClawAssistant, POSTMASTER_SYSTEM_PROMPT } from "./assistant.js";

test("natural language requests carry direction and naming instructions to OpenClaw", async () => {
  const originalFetch = globalThis.fetch;
  let payload: any;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Updated x300 (inbound)." } }],
      }),
    );
  };
  try {
    const assistant = new OpenClawAssistant(
      { baseUrl: "http://assistant.test", token: "test-token" },
      {
        add: async () => {
          throw new Error("Should use the model");
        },
        status: async () => "",
        help: () => "",
      },
    );
    await assistant.reply(
      "Please name my USPS package x300 and mark it inbound.",
      "test",
    );
    assert.equal(payload.messages[0].role, "system");
    assert.equal(payload.messages[0].content, POSTMASTER_SYSTEM_PROMPT);
    assert.match(
      payload.messages[0].content,
      /name "x300", direction "inbound"/,
    );
    assert.match(payload.messages[0].content, /postmaster_edit/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
