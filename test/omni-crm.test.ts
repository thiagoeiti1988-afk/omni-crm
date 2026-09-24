import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { authenticate, AuthError } from "../src/lib/auth";
import { handleJsonRpc, callTool, SERVER_VERSION } from "../src/lib/mcp";
import { OmniStore } from "../src/lib/store";
import type { AuthContext } from "../src/lib/types";

function withStore(fn: (store: OmniStore) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "omni-"));
  const store = OmniStore.open(join(dir, "test.sqlite"));
  store.ensureSeed();
  return Promise.resolve(fn(store)).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

function orgAuth(store: OmniStore, apiKey: string, role: AuthContext["role"] = "agent"): AuthContext {
  return authenticate(store, {
    authorization: `Bearer ${apiKey}`,
    role,
    agentId: `test-${role}`,
  });
}

describe("Omni-CRM kernel", () => {
  it("rejects missing bearer", () =>
    withStore((store) => {
      assert.throws(
        () => authenticate(store, { authorization: null }),
        (err: unknown) => err instanceof AuthError,
      );
    }));

  it("initialize returns 0.1.0 and official protocol", () =>
    withStore((store) => {
      const auth = orgAuth(store, "omni_org_acme_demo");
      const { payload } = handleJsonRpc(store, { jsonrpc: "2.0", id: 1, method: "initialize" }, auth);
      const result = (payload as { result: { protocolVersion: string; serverInfo: { version: string } } }).result;
      assert.equal(result.serverInfo.version, SERVER_VERSION);
      assert.equal(result.protocolVersion, "2024-11-05");
    }));

  it("tools/list includes list_tasks and create_copy_job", () =>
    withStore((store) => {
      const auth = orgAuth(store, "omni_org_acme_demo");
      const { payload } = handleJsonRpc(store, { jsonrpc: "2.0", id: 2, method: "tools/list" }, auth);
      const names = (payload as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
      for (const name of [
        "list_tasks",
        "get_task",
        "update_task_status",
        "append_agent_log",
        "search_agent_memory",
        "upsert_lead",
        "get_icp",
        "search_copy",
        "create_copy_job",
        "get_insights",
        "run_ops_agent",
      ]) {
        assert.ok(names.includes(name), name);
      }
    }));

  it("tools/call list_tasks matches store", () =>
    withStore((store) => {
      const auth = orgAuth(store, "omni_org_acme_demo");
      const { payload } = handleJsonRpc(
        store,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "list_tasks", arguments: {} },
        },
        auth,
      );
      const listed = (payload as { result: { structuredContent: unknown[] } }).result.structuredContent;
      assert.equal(listed.length, store.listTasks(auth.org.id).length);
    }));

  it("blocks illegal status transition", () =>
    withStore((store) => {
      const auth = orgAuth(store, "omni_org_acme_demo");
      const todo = store.listTasks(auth.org.id).find((t) => t.status === "todo")!;
      assert.throws(() => store.updateTaskStatus(auth, todo.id, "done"));
    }));

  it("agent can move todo to in_progress then in_review but not done", () =>
    withStore((store) => {
      const auth = orgAuth(store, "omni_org_acme_demo", "agent");
      const todo = store.listTasks(auth.org.id).find((t) => t.status === "todo")!;
      assert.equal(store.updateTaskStatus(auth, todo.id, "in_progress").status, "in_progress");
      assert.equal(store.updateTaskStatus(auth, todo.id, "in_review").status, "in_review");
      assert.throws(() => store.updateTaskStatus(auth, todo.id, "done"), /Only human/);
    }));

  it("isolates tenants: Acme cannot see Beta leads", () =>
    withStore((store) => {
      const acme = orgAuth(store, "omni_org_acme_demo");
      const beta = orgAuth(store, "omni_org_beta_demo");
      const acmeLeads = store.listLeads(acme.org.id);
      const betaLeads = store.listLeads(beta.org.id);
      assert.equal(acmeLeads.length, 18);
      assert.equal(betaLeads.length, 2);
      assert.ok(acmeLeads.every((l) => l.orgId === acme.org.id));
      assert.ok(betaLeads.every((l) => l.orgId === beta.org.id));
      assert.equal(store.getTask(acme.org.id, store.listTasks(beta.org.id)[0].id), undefined);
    }));

  it("lead capture requires consent and is idempotent by email", () =>
    withStore((store) => {
      const auth = orgAuth(store, "omni_org_acme_demo");
      const projectId = store.listProjects(auth.org.id)[0].id;
      assert.throws(
        () =>
          store.upsertLead(auth, {
            projectId,
            name: "X",
            email: "x@acme.test",
            source: "form",
            consent: false,
          }),
        /Consent/,
      );
      const first = store.upsertLead(auth, {
        projectId,
        name: "Nova Lead",
        email: "nova@acme.test",
        source: "form",
        consent: true,
        externalId: "form-1",
      });
      const second = store.upsertLead(auth, {
        projectId,
        name: "Nova Lead Atualizada",
        email: "nova@acme.test",
        source: "whatsapp",
        consent: true,
        externalId: "form-1",
      });
      assert.equal(first.id, second.id);
      assert.equal(second.source, "whatsapp");
      assert.ok(store.listLeads(auth.org.id).length >= 11);
    }));

  it("search_agent_memory finds the seeded kernel log", () =>
    withStore((store) => {
      const auth = orgAuth(store, "omni_org_acme_demo");
      store.appendAgentLog(auth, {
        actionType: "ANALYSIS",
        logContent: "Memória vetorial sobre copy para diretor comercial B2B e leads frios.",
      });
      const hits = store.searchMemory(auth.org.id, "diretor comercial copy leads frios", 3);
      assert.ok(hits.length > 0);
      assert.ok(hits[0].score > 0.1);
      const beta = orgAuth(store, "omni_org_beta_demo");
      const betaHits = store.searchMemory(beta.org.id, "diretor comercial copy leads frios", 3);
      assert.ok(!betaHits.some((h) => h.orgId === auth.org.id));
    }));

  it("copy job requires approved ICP, cites ICP+memory, human review", () =>
    withStore((store) => {
      const agent = orgAuth(store, "omni_org_acme_demo", "agent");
      const human = orgAuth(store, "omni_org_acme_demo", "human");
      const projectId = store.listProjects(agent.org.id)[0].id;
      const lead = store.listLeads(agent.org.id)[0];
      const copy = store.createCopyJob(agent, { projectId, leadId: lead.id, channel: "email" });
      assert.equal(copy.status, "in_review");
      assert.ok(copy.citations.includes(`icp:${store.getIcp(agent.org.id, projectId)!.id}`));
      assert.ok(copy.body.includes(lead.name.split(" ")[0]));
      assert.throws(() => store.reviewCopy(agent, copy.id, "approved"), /Only human/);
      const approved = store.reviewCopy(human, copy.id, "approved");
      assert.equal(approved.status, "approved");
    }));

  it("dashboard counts equal task rows", () =>
    withStore((store) => {
      const auth = orgAuth(store, "omni_org_acme_demo", "human");
      const dash = store.dashboard(auth);
      assert.equal(dash.tasks.length, store.listTasks(auth.org.id).length);
      assert.ok(dash.pipelines.length >= 1);
      assert.ok(dash.leads.length >= 10);
      assert.equal(dash.health.mcp, true);
      assert.ok(dash.org.apiKey.endsWith("…"));
    }));

  it("method not found stays jsonrpc", () =>
    withStore((store) => {
      const auth = orgAuth(store, "omni_org_acme_demo");
      const { payload } = handleJsonRpc(store, { jsonrpc: "2.0", id: 9, method: "nope" }, auth);
      assert.equal((payload as { error: { code: number } }).error.code, -32601);
    }));

  it("callTool get_task_status alias works", () =>
    withStore((store) => {
      const auth = orgAuth(store, "omni_org_acme_demo");
      const task = store.listTasks(auth.org.id)[0];
      const got = callTool(store, auth, "get_task_status", { taskId: task.id }) as { id: string };
      assert.equal(got.id, task.id);
    }));
});
