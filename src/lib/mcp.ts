import { AuthError } from "./auth";
import { StoreError, type OmniStore } from "./store";
import { buildInsights } from "./analytics";
import { runOpsAgent, type OpsAgentName } from "./agents";
import type { AuthContext, LeadStage } from "./types";

export const PROTOCOL_VERSION = "2024-11-05";
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

const INSTRUCTIONS =
  "Omni-CRM: CRM com governança de agentes. Você é um agente executor: mova Quantas até in_review, nunca done; " +
  "capture leads só com consentimento; ao escrever copy, envie title/body em create_copy_job — a peça entra em " +
  "Human Review e só um humano aprova. Mover lead no funil e aprovar ICP/copy exigem credencial humana ou harness.";
export const SERVER_VERSION = "0.1.0";

export const TOOLS = [
  {
    name: "list_tasks",
    description: "List Quanta tasks for the authenticated organization.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
    },
  },
  {
    name: "get_task",
    description: "Get one task by id (org-scoped).",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "update_task_status",
    description:
      "Update task status. Agents may move todo→in_progress→in_review. done requires human/harness.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        status: { type: "string", enum: ["todo", "in_progress", "in_review", "done"] },
      },
      required: ["taskId", "status"],
    },
  },
  {
    name: "append_agent_log",
    description: "Persist an agent log and embed it for RAG.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        projectId: { type: "string" },
        actionType: { type: "string" },
        logContent: { type: "string" },
      },
      required: ["actionType", "logContent"],
    },
  },
  {
    name: "search_agent_memory",
    description: "Cosine search over org-scoped agent logs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "upsert_lead",
    description: "Capture or dedupe a lead. Consent is mandatory.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        source: { type: "string" },
        utm: { type: "string" },
        consent: { type: "boolean" },
        stage: { type: "string" },
        externalId: { type: "string" },
      },
      required: ["projectId", "name", "email", "source", "consent"],
    },
  },
  {
    name: "list_leads",
    description: "List leads for the authenticated org.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_icp",
    description: "Get the ICP profile for a project.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
    },
  },
  {
    name: "search_copy",
    description: "Search copy assets by similarity.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "create_copy_job",
    description:
      "Create a copy piece from the approved ICP + memory. Pass your own title/body to act as the copywriter; " +
      "otherwise a template is used. Always lands in Human Review with ICP/memory citations.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        leadId: { type: "string" },
        channel: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["projectId", "channel"],
    },
  },
  {
    name: "update_lead_stage",
    description: "Move a lead in the sales funnel (human/harness only; emits billable events).",
    inputSchema: {
      type: "object",
      properties: {
        leadId: { type: "string" },
        stage: { type: "string", enum: ["new", "qualified", "nurturing", "proposal", "won", "lost"] },
        amount: { type: "number" },
      },
      required: ["leadId", "stage"],
    },
  },
  {
    name: "review_copy",
    description: "Approve or reject copy (human/harness only).",
    inputSchema: {
      type: "object",
      properties: {
        copyId: { type: "string" },
        decision: { type: "string", enum: ["approved", "rejected"] },
      },
      required: ["copyId", "decision"],
    },
  },
  {
    name: "get_insights",
    description: "Sales + agent KPIs, funnel, source attribution, linear/parabola forecast.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_ops_agent",
    description: "Dispatch analyst | copywriter | scout | icp against org data and memory.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["analyst", "copywriter", "scout", "icp"] },
        prompt: { type: "string" },
        leadId: { type: "string" },
        channel: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["agent"],
    },
  },
] as const;

type JsonRpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

function ok(id: JsonRpc["id"], result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

function fail(id: JsonRpc["id"], code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

// MCP exige structuredContent como objeto JSON; listas e escalares vão embrulhados.
function textResult(data: unknown, isError = false) {
  const structured =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : Array.isArray(data)
        ? { items: data }
        : { value: data ?? null };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError,
    structuredContent: structured,
  };
}

function asArgs(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object") return {};
  const p = params as { name?: string; arguments?: unknown };
  if (p.arguments && typeof p.arguments === "object") {
    return p.arguments as Record<string, unknown>;
  }
  return params as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function handleJsonRpc(
  store: OmniStore,
  body: JsonRpc,
  auth: AuthContext,
): { status: number; payload: unknown } {
  if (body.jsonrpc && body.jsonrpc !== "2.0") {
    return { status: 200, payload: fail(body.id, -32600, "jsonrpc must be 2.0") };
  }
  const method = body.method ?? "";

  if (method === "initialize") {
    const requested = (body.params as { protocolVersion?: string } | undefined)?.protocolVersion;
    const protocolVersion = !requested
      ? PROTOCOL_VERSION
      : (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
    return {
      status: 200,
      payload: ok(body.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "omni-crm-mcp", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      }),
    };
  }

  // Notificações JSON-RPC não têm resposta; no Streamable HTTP o servidor devolve 202 sem corpo.
  if (method.startsWith("notifications/") || method === "initialized") {
    return { status: 202, payload: null };
  }

  if (method === "ping") {
    return { status: 200, payload: ok(body.id, {}) };
  }

  if (method === "tools/list" || method === "mcp.tools.list") {
    return { status: 200, payload: ok(body.id, { tools: TOOLS }) };
  }

  if (method === "tools/call") {
    try {
      const params = (body.params ?? {}) as { name?: string; arguments?: unknown };
      const name = params.name;
      const args = asArgs(body.params);
      if (!name) return { status: 200, payload: fail(body.id, -32602, "Missing tool name") };
      const result = callTool(store, auth, name, args);
      return { status: 200, payload: ok(body.id, textResult(result)) };
    } catch (err) {
      if (err instanceof StoreError) {
        return {
          status: 200,
          payload: ok(body.id, textResult({ error: err.message, status: err.status }, true)),
        };
      }
      if (err instanceof AuthError) {
        return { status: 401, payload: { error: err.message } };
      }
      throw err;
    }
  }

  // Legacy aliases from the mock pack — still work so old docs do not hard-fail.
  if (method === "mcp.initialize") {
    return handleJsonRpc(store, { ...body, method: "initialize" }, auth);
  }

  return { status: 200, payload: fail(body.id, -32601, `Method not found: ${method}`) };
}

export function callTool(
  store: OmniStore,
  auth: AuthContext,
  name: string,
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case "list_tasks":
      return store.listTasks(auth.org.id, str(args.projectId));
    case "get_task":
    case "get_task_status": {
      const taskId = str(args.taskId);
      if (!taskId) throw new StoreError("taskId required");
      const task = store.getTask(auth.org.id, taskId);
      if (!task) throw new StoreError("Task not found", 404);
      return task;
    }
    case "update_task_status": {
      const taskId = str(args.taskId);
      const status = str(args.status);
      if (!taskId || !status) throw new StoreError("taskId and status required");
      return store.updateTaskStatus(auth, taskId, status);
    }
    case "append_agent_log": {
      const actionType = str(args.actionType);
      const logContent = str(args.logContent);
      if (!actionType || !logContent) throw new StoreError("actionType and logContent required");
      return store.appendAgentLog(auth, {
        taskId: str(args.taskId),
        projectId: str(args.projectId),
        actionType,
        logContent,
      });
    }
    case "search_agent_memory": {
      const query = str(args.query);
      if (!query) throw new StoreError("query required");
      return store.searchMemory(auth.org.id, query, Number(args.limit ?? 5));
    }
    case "upsert_lead": {
      if (typeof args.consent !== "boolean") throw new StoreError("consent boolean required");
      const projectId = str(args.projectId);
      const leadName = str(args.name);
      const email = str(args.email);
      const source = str(args.source);
      if (!projectId || !leadName || !email || !source) {
        throw new StoreError("projectId, name, email, source required");
      }
      return store.upsertLead(auth, {
        projectId,
        name: leadName,
        email,
        phone: str(args.phone),
        source,
        utm: str(args.utm),
        consent: args.consent,
        stage: str(args.stage) as LeadStage | undefined,
        externalId: str(args.externalId),
      });
    }
    case "list_leads":
      return store.listLeads(auth.org.id);
    case "get_icp":
      return store.getIcp(auth.org.id, str(args.projectId)) ?? null;
    case "search_copy": {
      const query = str(args.query);
      if (!query) throw new StoreError("query required");
      return store.searchCopy(auth.org.id, query, Number(args.limit ?? 5));
    }
    case "create_copy_job": {
      const projectId = str(args.projectId);
      const channel = str(args.channel);
      if (!projectId || !channel) throw new StoreError("projectId and channel required");
      const body = str(args.body);
      return store.createCopyJob(
        auth,
        { projectId, leadId: str(args.leadId), channel },
        body ? { title: str(args.title) ?? "", body, author: auth.agentId } : undefined,
      );
    }
    case "update_lead_stage": {
      const leadId = str(args.leadId);
      const stage = str(args.stage);
      if (!leadId || !stage) throw new StoreError("leadId and stage required");
      return store.updateLeadStage(auth, leadId, stage, typeof args.amount === "number" ? args.amount : undefined);
    }
    case "review_copy": {
      const copyId = str(args.copyId);
      const decision = str(args.decision);
      if (!copyId || (decision !== "approved" && decision !== "rejected")) {
        throw new StoreError("copyId and decision required");
      }
      return store.reviewCopy(auth, copyId, decision);
    }
    case "get_insights": {
      const icp = store.getIcp(auth.org.id) ?? null;
      return buildInsights({
        leads: store.listLeads(auth.org.id),
        tasks: store.listTasks(auth.org.id),
        copies: store.listCopies(auth.org.id),
        icp,
      });
    }
    case "run_ops_agent": {
      const agent = str(args.agent) as OpsAgentName | undefined;
      if (!agent || !["analyst", "copywriter", "scout", "icp"].includes(agent)) {
        throw new StoreError("agent must be analyst|copywriter|scout|icp");
      }
      return runOpsAgent(store, auth, {
        agent,
        prompt: str(args.prompt),
        leadId: str(args.leadId),
        channel: str(args.channel),
        projectId: str(args.projectId),
      });
    }
    default:
      throw new StoreError(`Unknown tool ${name}`, 404);
  }
}
