import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8877",
    browserName: "chromium",
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  },
  webServer: {
    command: "npx tsx tests/serve.ts",
    url: "http://127.0.0.1:8877/healthz",
    reuseExistingServer: false,
  },
});
