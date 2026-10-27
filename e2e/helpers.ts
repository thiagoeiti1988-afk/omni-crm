import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const PASSWORD = "omni-demo-2026";

export async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

/** Contexto de API com cookie de sessão (mesma origem, como o browser faria). */
export async function apiLogin(request: APIRequestContext, email: string) {
  const res = await request.post("/api/auth/login", { data: { email, password: PASSWORD } });
  expect(res.status()).toBe(200);
}

export function uniq(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
