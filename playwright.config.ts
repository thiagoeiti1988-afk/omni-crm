import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

export const E2E_ENV = {
  MCP_API_KEY: "e2e-master-key",
  WHATSAPP_APP_SECRET: "e2e-app-secret",
  WHATSAPP_VERIFY_TOKEN: "e2e-verify-token",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Ambientes com Chromium pré-instalado de outra versão: E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium
        launchOptions: process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {},
      },
    },
  ],
  webServer: {
    command: `rm -f data/e2e.sqlite* && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { ...E2E_ENV, OMNI_DB_PATH: "data/e2e.sqlite", OMNI_LOG: "0", NODE_ENV: "production", OMNI_INSECURE_COOKIES: "1" },
  },
});
