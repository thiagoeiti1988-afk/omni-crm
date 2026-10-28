import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { authenticate, can } from "../src/lib/auth";
import { handleJsonRpc } from "../src/lib/mcp";
import { OmniStore } from "../src/lib/store";
import { parseCsv } from "../src/lib/csv";
import { verifyHubSignature, hashPassword, verifyPassword } from "../src/lib/security";
import type { AuthContext } from "../src/lib/types";

const PASSWORD = "omni-demo-2026";

function withStore(fn: (store: OmniStore, dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "omni-plat-"));
  const store = OmniStore.open(join(dir, "t.sqlite"));
  store.ensureSeed();
  return Promise.resolve(fn(store, dir)).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

const agent = (s: OmniStore, key = "omni_org_acme_demo") =>
  authenticate(s, { authorization: `Bearer ${key}`, role: "harness" });
const harness = (s: OmniStore) => authenticate(s, { authorization: "Bearer omni_org_acme_harness_demo" });
function user(s: OmniStore, email: string): AuthContext {
  const session = s.login(email, PASSWORD);
  assert.ok(session, `login ${email}`);
  return s.sessionAuth(session.token)!;
}

describe("auth: sessões e RBAC", () => {
  it("scrypt verifica e rejeita", () => {
    const h = hashPassword("senha-forte-123");
    assert.ok(verifyPassword("senha-forte-123", h));
    assert.ok(!verifyPassword("senha-errada-123", h));
  });

  it("login certo cria sessão; errado e e-mail inexistente devolvem null; logout revoga", () =>
    withStore((s) => {
      assert.equal(s.login("owner@acme.demo", "errada"), null);
      assert.equal(s.login("ninguem@acme.demo", PASSWORD), null);
      const session = s.login("OWNER@acme.demo", PASSWORD)!;
      const auth = s.sessionAuth(session.token)!;
      assert.equal(auth.user?.role, "owner");
      assert.equal(auth.org.id, "org-acme");
      s.logout(session.token);
      assert.equal(s.sessionAuth(session.token), null);
    }));

  it("matriz: agente sem permissão humana; copy só revisa; closer não administra", () =>
    withStore((s) => {
      const a = agent(s);
      assert.equal(a.role, "agent", "header X-Actor-Role não promove a agent key");
      for (const p of ["task.done", "copy.review", "lead.stage", "billing.view", "org.keys"] as const) {
        assert.ok(!can(a, p), p);
      }
      const copy = user(s, "copy@acme.demo");
      assert.ok(can(copy, "copy.review"));
      assert.ok(!can(copy, "lead.stage"));
      const closer = user(s, "closer@acme.demo");
      assert.ok(can(closer, "lead.stage") && can(closer, "billing.view"));
      assert.ok(!can(closer, "org.keys") && !can(closer, "lead.erase"));
      assert.ok(!can(harness(s), "org.keys"));
    }));
});

describe("funil e faturamento por resultado", () => {
  it("agente não move funil; closer move e gera eventos idempotentes", () =>
    withStore((s) => {
      const lead = s.listLeads("org-acme").find((l) => l.stage === "new")!;
      assert.throws(() => s.updateLeadStage(agent(s), lead.id, "won"), /closer, owner or harness/);
      const closer = user(s, "closer@acme.demo");
      const before = s.billingUsage(closer).lines;
      s.updateLeadStage(closer, lead.id, "qualified");
      s.updateLeadStage(closer, lead.id, "won", 30000);
      s.updateLeadStage(closer, lead.id, "won");
      const after = s.billingUsage(closer).lines;
      const delta = (k: string) =>
        after.find((l) => l.kind === k)!.count - before.find((l) => l.kind === k)!.count;
      assert.equal(delta("lead_qualified"), 1);
      assert.equal(delta("deal_won"), 1, "ganhar duas vezes não cobra duas vezes");
      assert.equal(s.getLead("org-acme", lead.id)!.amount, 30000);
    }));

  it("recaptura não regride estágio", () =>
    withStore((s) => {
      const lead = s.listLeads("org-acme").find((l) => l.stage === "proposal")!;
      const again = s.upsertLead(agent(s), {
        projectId: lead.projectId,
        name: lead.name,
        email: lead.email,
        source: "form",
        consent: true,
      });
      assert.equal(again.id, lead.id);
      assert.equal(again.stage, "proposal");
    }));

  it("agente não cria lead já ganho (não fatura sozinho)", () =>
    withStore((s) => {
      const projectId = s.listProjects("org-acme")[0].id;
      const lead = s.upsertLead(agent(s), {
        projectId,
        name: "Fake Win",
        email: "fake@win.com",
        source: "form",
        consent: true,
        stage: "won",
      });
      assert.equal(lead.stage, "new");
    }));

  it("papel copy aprova peça; isso fecha a Quanta (gate humano) e fatura uma vez", () =>
    withStore((s) => {
      const projectId = s.listProjects("org-acme")[0].id;
      const copy = s.createCopyJob(
        agent(s),
        { projectId, channel: "email" },
        { title: "Assunto", body: "Corpo escrito pelo agente", author: "cursor" },
      );
      assert.equal(copy.body, "Corpo escrito pelo agente");
      const reviewer = user(s, "copy@acme.demo");
      s.reviewCopy(reviewer, copy.id, "approved");
      const task = s.listTasks("org-acme").find((t) => t.description === copy.id)!;
      assert.equal(task.status, "done");
      assert.throws(() => s.reviewCopy(reviewer, copy.id, "rejected"), /already approved/);
      const usage = s.billingUsage(user(s, "owner@acme.demo"));
      assert.equal(usage.lines.find((l) => l.kind === "copy_approved")!.count, 1);
    }));

  it("template de copy não vaza briefing, e-mail do lead nem pitch do Omni-CRM", () =>
    withStore((s) => {
      const lead = s.listLeads("org-acme")[0];
      const copy = s.createCopyJob(agent(s), { projectId: lead.projectId, leadId: lead.id, channel: "email" });
      assert.ok(!copy.body.includes(lead.email));
      assert.ok(!/Omni-CRM|Dor:|Tom:|Oferta:/.test(copy.body));
      assert.ok(copy.body.includes(lead.name.split(" ")[0]));
    }));

  it("CAS: transição concorrente vira 409 em vez de sobrescrever", () =>
    withStore((s, dir) => {
      const other = OmniStore.open(join(dir, "t.sqlite"));
      try {
        const task = s.listTasks("org-acme").find((t) => t.status === "in_review")!;
        const h = harness(s);
        const realGet = s.getTask.bind(s);
        // Outro processo fecha a Quanta entre a leitura e a escrita deste.
        s.getTask = (orgId, taskId) => {
          const snapshot = realGet(orgId, taskId);
          other.updateTaskStatus(
            authenticate(other, { authorization: "Bearer omni_org_acme_harness_demo" }),
            taskId,
            "done",
          );
          return snapshot;
        };
        assert.throws(() => s.updateTaskStatus(h, task.id, "in_progress"), /concurrently/);
      } finally {
        other.close();
      }
    }));
});

describe("LGPD", () => {
  it("export traz dados; erase anonimiza, apaga eventos e peças, preserva faturamento", () =>
    withStore((s) => {
      const owner = user(s, "owner@acme.demo");
      const lead = s.listLeads("org-acme").find((l) => l.stage === "won")!;
      s.createCopyJob(agent(s), { projectId: lead.projectId, leadId: lead.id, channel: "email" });
      const exported = s.exportLead(owner, lead.id);
      assert.equal(exported.lead.email, lead.email);
      assert.equal(exported.copies.length, 1);
      assert.throws(() => s.eraseLead(user(s, "closer@acme.demo"), lead.id), /owner/);
      const billedBefore = s.billingUsage(owner).lines.find((l) => l.kind === "deal_won")!.count;
      const erased = s.eraseLead(owner, lead.id);
      assert.equal(erased.name, "Titular removido");
      assert.equal(erased.email, "");
      assert.ok(erased.erasedAt);
      assert.equal(s.listLeadEvents("org-acme", lead.id).length, 0);
      assert.equal(s.listCopies("org-acme").filter((c) => c.leadId === lead.id).length, 0);
      assert.equal(s.billingUsage(owner).lines.find((l) => l.kind === "deal_won")!.count, billedBefore);
      assert.ok(!s.dashboard(owner).leads.some((l) => l.id === lead.id));
      // listLeads alimenta list_leads (MCP), get_insights e o agente de operação
      assert.ok(!s.listLeads("org-acme").some((l) => l.id === lead.id));
    }));
});

describe("importação CSV", () => {
  it("parser lida com aspas, ; e quebra de linha", () => {
    assert.deepEqual(parseCsv('a;b\n"x;1";"di""z"\n"multi\nlinha";2\n'), [
      ["a", "b"],
      ["x;1", 'di"z'],
      ["multi\nlinha", "2"],
    ]);
  });

  it("importa cabeçalhos PT, ignora sem consentimento, deduplica", () =>
    withStore((s) => {
      const owner = user(s, "owner@acme.demo");
      const csv = [
        "Nome;E-mail;Telefone;Origem;Etapa;Valor;Consentimento",
        'Rita Nova;rita@nova.com;(11) 98888-0000;Indicação;Proposta;"12.500,00";sim',
        "Sem Opt;semopt@x.com;;site;;;não",
        "Rita Nova Atualizada;rita@nova.com;;whatsapp;;;sim",
        "So Fone;;+55 11 97777-1111;WhatsApp;;;sim",
      ].join("\n");
      const r = s.importLeadsCsv(owner, csv);
      assert.equal(r.imported, 2);
      assert.equal(r.updated, 1);
      assert.equal(r.skipped.length, 1);
      const rita = s.listLeads("org-acme").find((l) => l.email === "rita@nova.com")!;
      assert.equal(rita.stage, "proposal");
      assert.equal(rita.amount, 12500);
      assert.equal(rita.source, "whatsapp");
      assert.equal(rita.consentBasis, "import");
      assert.throws(() => s.importLeadsCsv(user(s, "closer@acme.demo"), csv), /owner/);
    }));
});

describe("WhatsApp Cloud API", () => {
  const payload = (phoneId: string, msgId: string, from = "5511999990000") => ({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "551130000000", phone_number_id: phoneId },
              contacts: [{ profile: { name: "Marina Cliente" }, wa_id: from }],
              messages: [{ from, id: msgId, timestamp: "1730000000", type: "text", text: { body: "Quero saber o preço" } }],
            },
          },
        ],
      },
    ],
  });

  it("assinatura HMAC", () => {
    const body = JSON.stringify({ a: 1 });
    const sig = `sha256=${createHmac("sha256", "segredo").update(body).digest("hex")}`;
    assert.ok(verifyHubSignature(body, sig, "segredo"));
    assert.ok(!verifyHubSignature(body, sig, "outro"));
    assert.ok(!verifyHubSignature(`${body} `, sig, "segredo"));
    assert.ok(!verifyHubSignature(body, null, "segredo"));
  });

  it("cria lead na org certa, deduplica reentrega, ignora número desconhecido", () =>
    withStore((s) => {
      assert.deepEqual(s.ingestWhatsApp(payload("100000000000001", "wamid.1")), { processed: 1, duplicates: 0, ignored: 0 });
      assert.deepEqual(s.ingestWhatsApp(payload("100000000000001", "wamid.1")), { processed: 0, duplicates: 1, ignored: 0 });
      s.ingestWhatsApp(payload("100000000000001", "wamid.2"));
      const leads = s.listLeads("org-acme").filter((l) => l.externalId === "wa:5511999990000");
      assert.equal(leads.length, 1);
      assert.equal(leads[0].name, "Marina Cliente");
      assert.equal(leads[0].consentBasis, "inbound_contact");
      assert.equal(leads[0].email, "");
      const inbound = s.listLeadEvents("org-acme", leads[0].id).filter((e) => e.kind === "whatsapp_inbound");
      assert.equal(inbound.length, 2);
      assert.equal(s.listLeads("org-beta").filter((l) => l.externalId?.startsWith("wa:")).length, 0);
      assert.deepEqual(s.ingestWhatsApp(payload("999", "wamid.3")), { processed: 0, duplicates: 0, ignored: 1 });
      assert.deepEqual(s.ingestWhatsApp({ garbage: true }), { processed: 0, duplicates: 0, ignored: 0 });
    }));
});

describe("chaves, provisionamento e migração", () => {
  it("rotação invalida a chave antiga na hora", () =>
    withStore((s) => {
      const owner = user(s, "owner@acme.demo");
      const fresh = s.rotateKey(owner, "api");
      assert.throws(() => authenticate(s, { authorization: "Bearer omni_org_acme_demo" }), /Invalid API key/);
      assert.equal(authenticate(s, { authorization: `Bearer ${fresh}` }).org.id, "org-acme");
      assert.throws(() => s.rotateKey(user(s, "closer@acme.demo"), "api"), /owner/);
    }));

  it("createOrg provisiona org isolada com chaves aleatórias e owner", () =>
    withStore((s) => {
      const { org, owner } = s.createOrg({
        name: "Cliente Real",
        ownerEmail: "dona@cliente.com",
        ownerPassword: "senha-bem-longa",
      });
      assert.match(org.apiKey, /^omni_org_[\w-]{20,}/);
      assert.equal(owner.role, "owner");
      const auth = s.sessionAuth(s.login("dona@cliente.com", "senha-bem-longa")!.token)!;
      assert.equal(s.dashboard(auth).leads.length, 0);
      assert.equal(s.getIcp(org.id)?.status, "draft");
      assert.throws(
        () => s.createCopyJob(auth, { projectId: s.listProjects(org.id)[0].id, channel: "email" }),
        /approved/,
      );
    }));

  it("migra banco legado (v1, e-mail NOT NULL) sem perder lead", () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-legacy-"));
    const path = join(dir, "legacy.sqlite");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key TEXT NOT NULL UNIQUE,
        harness_key TEXT, created_at TEXT NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT 'Cursor',
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE companies (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE leads (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL, company_id TEXT,
        name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
        utm TEXT NOT NULL DEFAULT '', consent INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0,
        stage TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, external_id TEXT, created_at TEXT NOT NULL,
        UNIQUE (org_id, email), UNIQUE (org_id, external_id));
      CREATE TABLE lead_events (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, lead_id TEXT NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO organizations VALUES ('org-old', 'Velha', 'old_key', NULL, '2026-01-01');
      INSERT INTO projects VALUES ('p-old', 'org-old', 'P', '', 'Cursor', 'active', '2026-01-01', '2026-01-01');
      INSERT INTO leads VALUES ('l-old', 'org-old', 'p-old', NULL, 'Antigo', 'antigo@x.com', '', 'form', '',
        1, 40, 'proposal', 5000, NULL, '2026-01-01');
    `);
    db.close();
    try {
      const store = OmniStore.open(path);
      const lead = store.getLead("org-old", "l-old")!;
      assert.equal(lead.stage, "proposal");
      assert.equal(lead.consentBasis, "consent");
      const a = authenticate(store, { authorization: "Bearer old_key" });
      const noEmail = store.upsertLead(a, {
        projectId: "p-old",
        name: "Só fone",
        phone: "+5511",
        source: "whatsapp",
        consent: true,
      });
      assert.equal(noEmail.email, "");
      store.close();
      const reopened = OmniStore.open(path);
      assert.equal(reopened.listLeads("org-old").length, 2, "reabrir não roda a migração de novo");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP: conformidade", () => {
  it("negocia versão, notificação sem corpo, structuredContent é objeto", () =>
    withStore((s) => {
      const a = agent(s);
      const version = (requested: string) =>
        (
          handleJsonRpc(s, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: requested } }, a)
            .payload as { result: { protocolVersion: string } }
        ).result.protocolVersion;
      assert.equal(version("2025-11-25"), "2025-11-25");
      assert.equal(version("2025-06-18"), "2025-06-18");
      assert.equal(version("1999-01-01"), "2025-11-25");
      assert.deepEqual(handleJsonRpc(s, { jsonrpc: "2.0", method: "notifications/initialized" }, a), {
        status: 202,
        payload: null,
      });
      const call = handleJsonRpc(
        s,
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_leads", arguments: {} } },
        a,
      );
      const structured = (call.payload as { result: { structuredContent: unknown } }).result.structuredContent;
      assert.ok(structured && typeof structured === "object" && !Array.isArray(structured));
    }));

  it("agente via MCP escreve a própria copy e não consegue mover funil", () =>
    withStore((s) => {
      const a = agent(s);
      const projectId = s.listProjects("org-acme")[0].id;
      const created = handleJsonRpc(
        s,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "create_copy_job", arguments: { projectId, channel: "whatsapp", title: "Oi", body: "Mensagem do agente" } },
        },
        a,
      );
      const copy = (created.payload as { result: { structuredContent: { body: string; status: string } } }).result
        .structuredContent;
      assert.equal(copy.body, "Mensagem do agente");
      assert.equal(copy.status, "in_review");
      const lead = s.listLeads("org-acme")[0];
      const moved = handleJsonRpc(
        s,
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "update_lead_stage", arguments: { leadId: lead.id, stage: "won" } },
        },
        a,
      );
      assert.equal((moved.payload as { result: { isError: boolean } }).result.isError, true);
    }));
});
