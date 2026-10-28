import { expect, test, type Page } from "@playwright/test";
import { login, uniq } from "./helpers";

test("sem sessão vai para o login; senha errada mostra erro", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("E-mail").fill("owner@acme.demo");
  await page.getByLabel("Senha").fill("senha-errada");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.locator("form [role=alert]")).toContainText("inválidos");
});

/** Seleciona a peça na fila (se houver mais de uma) e devolve o cartão em revisão. */
async function openInReview(page: Page, title: string) {
  const pick = page.getByRole("list", { name: "Próximas na fila" }).getByRole("button", { name: new RegExp(title) });
  if (await pick.count()) await pick.click();
  const card = page.getByRole("article", { name: new RegExp(title) });
  await expect(card).toBeVisible();
  return card;
}

test("fluxo completo: site capta → agente escreve → humano aprova → Quanta fecha → fatura", async ({ page, request }) => {
  const name = uniq("Visitante");
  const email = `${name.toLowerCase()}@cliente.com.br`;

  // 1. Visitante envia o formulário HTML público (sem JS, form-urlencoded, como o snippet do site).
  const form = await request.post("/api/capture", {
    form: { key: "omni_pub_acme_demo", name, email, consent: "on", utm_source: "google_ads", website: "" },
  });
  expect(form.status()).toBe(200);
  expect(await form.text()).toContain("Recebemos seu contato");

  // 2. Owner entra e encontra o lead.
  await login(page, "owner@acme.demo");
  await expect(page.getByRole("heading", { name: "Acme Vendas" })).toBeVisible();
  await page.getByRole("button", { name: "Leads" }).click();
  await page.getByLabel("Filtrar leads").fill(name);
  const row = page.locator("tr", { hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("ads");

  // Faturamento antes da aprovação.
  await page.getByRole("button", { name: "Faturamento" }).click();
  const approvedLine = page.getByTestId("billing-copy_approved");
  await expect(approvedLine).toBeVisible();
  const approvedBefore = Number((await approvedLine.locator("td").nth(1).innerText()).trim());

  // 3. Gera a peça para o lead.
  await page.getByRole("button", { name: "Leads" }).click();
  await page.getByLabel("Filtrar leads").fill(name);
  await row.getByRole("button", { name: "Gerar copy" }).click();
  await expect(page.getByRole("status")).toContainText("Human Review");

  // 4. Human Review: a peça cita ICP, cumprimenta o lead pelo nome e não vaza o e-mail.
  await expect(page.getByTestId("review-waiting")).toContainText("aguardando você");
  await page.getByRole("button", { name: /Human Review/ }).click();
  const card = await openInReview(page, `para ${name}`);
  await expect(card).toContainText(`Olá ${name}`);
  await expect(card).toContainText("Fonte: ICP aprovado");
  await expect(card).not.toContainText(email);
  await card.getByRole("button", { name: /Aprovar/ }).click();
  await page.getByTestId("undo-toast").getByRole("button", { name: "Confirmar agora" }).click();
  await expect(page.getByRole("status")).toContainText("Quanta fechada");

  // 5. Quanta de revisão foi para Done.
  await page.getByRole("button", { name: "Quantas" }).click();
  await expect(page.getByTestId("column-done")).toContainText("Revisar copy email");

  // 6. Faturamento por resultado registrou exatamente uma aprovação a mais.
  await page.getByRole("button", { name: "Faturamento" }).click();
  await expect(approvedLine.locator("td").nth(1)).toHaveText(String(approvedBefore + 1));
  // Extrato diz o que foi cobrado e quem decidiu.
  const ledgerRow = page.getByTestId("billing-ledger").locator("tr", { hasText: `para ${name}` });
  await expect(ledgerRow).toContainText("owner@acme.demo");

  // 7. Sair encerra a sessão.
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

test("Human Review por teclado: A aprova, U desfaz antes de cobrar, e a decisão confirma sozinha", async ({ page, request }) => {
  const name = uniq("Teclado");
  const res = await request.post("/api/capture", {
    data: { key: "omni_pub_acme_demo", name, email: `${name.toLowerCase()}@x.com`, consent: true },
  });
  expect(res.status()).toBe(201);
  await login(page, "owner@acme.demo");
  await page.getByRole("button", { name: "Leads" }).click();
  await page.getByLabel("Filtrar leads").fill(name);
  await page.locator("tr", { hasText: name }).getByRole("button", { name: "Gerar copy" }).click();
  await expect(page.getByRole("status")).toContainText("Human Review");

  await page.getByRole("button", { name: /Human Review/ }).click();
  const card = await openInReview(page, `para ${name}`);
  await page.keyboard.press("a");
  const toast = page.getByTestId("undo-toast");
  await expect(toast).toContainText(`Aprovando`);
  await expect(card).toHaveCount(0);

  await page.keyboard.press("u");
  await expect(toast).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Decisão desfeita");
  await expect(await openInReview(page, `para ${name}`)).toBeVisible();

  // Sem clicar em nada: a janela de desfazer expira e a decisão vai ao servidor.
  await page.keyboard.press("a");
  await expect(page.getByRole("status")).toContainText("Quanta fechada", { timeout: 10_000 });
  await expect(page.getByRole("article", { name: new RegExp(`para ${name}`) })).toHaveCount(0);
});

test("closer move funil (gera lead qualificado faturável) e não vê Integrações", async ({ page }) => {
  await login(page, "closer@acme.demo");
  await expect(page.getByRole("button", { name: "Integrações" })).toHaveCount(0);

  await page.getByRole("button", { name: "Faturamento" }).click();
  const qualified = page.getByTestId("billing-lead_qualified").locator("td").nth(1);
  const before = Number((await qualified.innerText()).trim());

  await page.getByRole("button", { name: "Leads" }).click();
  const selects = page.locator("select[aria-label^='Estágio de']");
  await expect(selects.first()).toBeVisible();
  let index = -1;
  for (let i = 0; i < (await selects.count()); i++) {
    if ((await selects.nth(i).inputValue()) === "new") {
      index = i;
      break;
    }
  }
  expect(index, "precisa existir um lead em Novo").toBeGreaterThanOrEqual(0);
  const label = await selects.nth(index).getAttribute("aria-label");
  const select = page.getByLabel(label!, { exact: true });
  await select.selectOption("qualified");
  await expect(select).toHaveValue("qualified");

  await page.getByRole("button", { name: "Faturamento" }).click();
  await expect(qualified).toHaveText(String(before + 1));
});

test("papel copy revisa mas não move funil nem vê faturamento", async ({ page }) => {
  await login(page, "copy@acme.demo");
  await expect(page.getByRole("button", { name: "Faturamento" })).toHaveCount(0);
  await page.getByRole("button", { name: "Leads" }).click();
  await expect(page.locator("select[aria-label^='Estágio de']")).toHaveCount(0);
  await page.getByRole("button", { name: /Human Review/ }).click();
  await expect(page.getByText("Fila de revisão")).toBeVisible();
});

test("isolamento de tenant: Beta não enxerga leads da Acme", async ({ page, request }) => {
  const name = uniq("SoAcme");
  const res = await request.post("/api/capture", {
    data: { key: "omni_pub_acme_demo", name, email: `${name.toLowerCase()}@x.com`, consent: true },
  });
  expect(res.status()).toBe(201);
  await login(page, "owner@beta.demo");
  await expect(page.getByRole("heading", { name: "Beta Labs" })).toBeVisible();
  await page.getByRole("button", { name: "Leads" }).click();
  await page.getByLabel("Filtrar leads").fill(name);
  await expect(page.locator("tr", { hasText: name })).toHaveCount(0);
});

test("owner configura integrações: snippet de captura e config MCP", async ({ page }) => {
  await login(page, "owner@acme.demo");
  await page.getByRole("button", { name: "Integrações" }).click();
  await expect(page.getByText('name="key" value="omni_pub_acme_demo"')).toBeVisible();
  await expect(page.getByText("/api/mcp-server").first()).toBeVisible();
  await expect(page.getByText("Olívia Owner · owner@acme.demo")).toBeVisible();
});
