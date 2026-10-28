import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
// O servidor standalone faz chdir para .next/standalone: o caminho do banco precisa ser absoluto.
const DB_PATH = resolve("data/e2e.sqlite");

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
    // Mesmo artefato da imagem Docker (output: "standalone"), não `next start`.
    command:
      `rm -f ${DB_PATH}* && mkdir -p data && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/ ` +
      `&& node .next/standalone/server.js`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { ...E2E_ENV, PORT: String(PORT), HOSTNAME: "0.0.0.0", OMNI_DB_PATH: DB_PATH, OMNI_LOG: "0", NODE_ENV: "production", OMNI_INSECURE_COOKIES: "1" },
  },
});
