import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitLinear, fitQuadratic, predictLinear, rSquared } from "../src/lib/forecast";
import { buildInsights } from "../src/lib/analytics";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmniStore } from "../src/lib/store";
import { authenticate } from "../src/lib/auth";
import { callTool } from "../src/lib/mcp";
import { runOpsAgent } from "../src/lib/agents";
import type { Lead } from "../src/lib/types";

describe("forecast + insights", () => {
  it("fits y = 2x + 1 exactly", () => {
    const pts = [0, 1, 2, 3, 4].map((x) => ({ x, y: 2 * x + 1 }));
    const m = fitLinear(pts);
    assert.ok(Math.abs(m.slope - 2) < 1e-9);
    assert.ok(Math.abs(m.intercept - 1) < 1e-9);
    assert.equal(predictLinear(m, 10), 21);
    assert.ok(rSquared(pts, (x) => predictLinear(m, x)) > 0.999);
  });

  it("quadratic recovers a parabola", () => {
    const pts = [0, 1, 2, 3, 4].map((x) => ({ x, y: 3 + 0.5 * x + 0.25 * x * x }));
    const q = fitQuadratic(pts);
    assert.ok(Math.abs(q.a - 3) < 1e-6);
    assert.ok(Math.abs(q.b - 0.5) < 1e-6);
    assert.ok(Math.abs(q.c - 0.25) < 1e-6);
  });

  it("insights isolate sources and expected value", () => {
    const leads: Lead[] = [
      fakeLead({ source: "ads", stage: "new", amount: 10000, score: 40 }),
      fakeLead({ source: "whatsapp", stage: "won", amount: 20000, score: 80 }),
      fakeLead({ source: "whatsapp", stage: "lost", amount: 8000, score: 50 }),
    ];
    const ins = buildInsights({ leads, tasks: [], copies: [], icp: null });
    assert.equal(ins.kpis.leads, 3);
    assert.equal(ins.kpis.won, 1);
    assert.ok(ins.kpis.winRate > 0.4);
    const wa = ins.sources.find((s) => s.source === "whatsapp");
    assert.ok(wa && wa.winRate === 0.5);
    assert.ok(ins.kpis.expectedBrl >= 20000);
  });
});

describe("ops agents", () => {
  it("analyst and get_insights share funnel math", () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-"));
    const store = OmniStore.open(join(dir, "t.sqlite"));
    store.ensureSeed();
    try {
      const auth = authenticate(store, {
        authorization: "Bearer omni_org_acme_demo",
        role: "agent",
        agentId: "test-ops",
      });
      const insights = callTool(store, auth, "get_insights", {}) as { kpis: { leads: number } };
      assert.equal(insights.kpis.leads, 18);
      const out = runOpsAgent(store, auth, { agent: "scout", prompt: "onde caçar" });
      assert.match(out.report, /Scout/);
      assert.ok(out.insights && out.insights.sources.length >= 1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fakeLead(p: Partial<Lead>): Lead {
  return {
    id: crypto.randomUUID(),
    orgId: "org-acme",
    projectId: "p",
    companyId: null,
    name: "X",
    email: "x@y.z",
    phone: "",
    source: "form",
    utm: "",
    consent: true,
    score: 50,
    stage: "new",
    amount: 1000,
    externalId: null,
    createdAt: new Date().toISOString(),
    ...p,
  };
}
