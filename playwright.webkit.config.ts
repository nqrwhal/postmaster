import config from "./playwright.config";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  ...config,
  use: { ...config.use, browserName: "webkit" },
});
