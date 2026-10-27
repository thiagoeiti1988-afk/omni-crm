import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { draftCopyWithClaude } from "../src/lib/copywriter";
import type { IcpProfile } from "../src/lib/types";

const icp: IcpProfile = {
  id: "icp-1",
  orgId: "org",
  projectId: "p",
  persona: "Diretor comercial B2B",
  pains: "leads frios",
  language: "Direto",
  channels: "WhatsApp, e-mail",
  offer: "CRM com agentes e revisão humana",
  exclusions: "Infoproduto",
  status: "approved",
  updatedAt: "2026-01-01",
};

type Captured = { path?: string; body?: Record<string, unknown>; apiKey?: string };

// Mock da Messages API: o SDK oficial faz a requisição HTTP real contra ele.
function startMock(reply: (captured: Captured) => { status: number; body: unknown }) {
  const captured: Captured = {};
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      captured.path = req.url;
      captured.apiKey = String(req.headers["x-api-key"] ?? req.headers.authorization ?? "").replace(/^Bearer /, "");
      captured.body = JSON.parse(raw || "{}");
      const { status, body } = reply(captured);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise<{ server: Server; url: string; captured: Captured }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, captured }),
    ),
  );
}

function message(text: string, stop_reason = "end_turn") {
  return {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

describe("copywriter Claude (mock da Messages API)", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };
  before(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });
  after(() => {
    process.env.ANTHROPIC_API_KEY = saved.key;
    process.env.ANTHROPIC_BASE_URL = saved.url;
    if (!saved.key) delete process.env.ANTHROPIC_API_KEY;
    if (!saved.url) delete process.env.ANTHROPIC_BASE_URL;
  });

  it("sem chave não chama nada e devolve null (template assume)", async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.equal(await draftCopyWithClaude({ icp, memory: [], channel: "email" }), null);
    } finally {
      process.env.ANTHROPIC_API_KEY = key;
    }
  });

  it("envia modelo, effort e JSON schema; trata dados do CRM como dados; parseia a saída", async () => {
    const mock = await startMock(() => ({
      status: 200,
      body: message(JSON.stringify({ title: "Leads frios?", body: "Oi Ana, vi que leads frios travam seu time. Topa 15 min?" })),
    }));
    process.env.ANTHROPIC_BASE_URL = mock.url;
    try {
      const draft = await draftCopyWithClaude({
        icp,
        lead: {
          id: "l1", orgId: "org", projectId: "p", companyId: null, name: "Ana Souza", email: "ana@x.com", phone: "",
          source: "whatsapp", utm: "", consent: true, consentBasis: "consent", consentAt: null, score: 50,
          stage: "qualified", amount: 0, externalId: null, erasedAt: null, createdAt: "2026-01-01",
        },
        memory: [{ logContent: "WhatsApp converte melhor" }],
        channel: "whatsapp",
      });
      assert.deepEqual(draft, {
        title: "Leads frios?",
        body: "Oi Ana, vi que leads frios travam seu time. Topa 15 min?",
        author: "claude-opus-5-5",
      });
      const body = mock.captured.body!;
      assert.equal(mock.captured.path, "/v1/messages");
      assert.equal(mock.captured.apiKey, "sk-ant-test");
      assert.equal(body.model, "claude-opus-5-5");
      const output = body.output_config as { effort: string; format: { type: string; schema: { required: string[] } } };
      assert.equal(output.effort, "medium");
      assert.equal(output.format.type, "json_schema");
      assert.deepEqual([...output.format.schema.required].sort(), ["body", "title"]);
      const userText = JSON.stringify(body.messages);
      assert.ok(userText.includes("<dados>"), "conteúdo do CRM vai delimitado como dados");
      assert.ok(!userText.includes("ana@x.com"), "e-mail do lead não vai para o modelo");
      assert.ok(String(body.system).includes("não instrução"));
    } finally {
      mock.server.close();
    }
  });

  it("recusa, JSON inválido e erro HTTP caem no template (null)", async () => {
    for (const reply of [
      { status: 200, body: message("", "refusal") },
      { status: 200, body: message("não é json") },
      { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad" } } },
    ]) {
      const mock = await startMock(() => reply);
      process.env.ANTHROPIC_BASE_URL = mock.url;
      try {
        assert.equal(await draftCopyWithClaude({ icp, memory: [], channel: "email" }), null);
      } finally {
        mock.server.close();
      }
    }
  });
});
