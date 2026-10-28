-- Omni-CRM schema (Postgres / Supabase target)
-- Runtime atual usa SQLite equivalente em src/lib/store.ts (node:sqlite).
-- Espelha o schema v2 do SQLite (PRAGMA user_version = 2): login, LGPD, faturamento, WhatsApp.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    harness_key TEXT,
    capture_key TEXT,
    whatsapp_phone_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    platform TEXT,
    status TEXT DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'in_review', 'done')),
    assigned_agent TEXT,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS agent_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    agent_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    log_content TEXT NOT NULL,
    embedding VECTOR(1536),
    embedding_model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS pipelines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_stages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    lead_stage TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS icp_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    persona TEXT NOT NULL,
    pains TEXT NOT NULL,
    language TEXT NOT NULL,
    channels TEXT NOT NULL,
    offer TEXT NOT NULL,
    exclusions TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'approved')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT,  -- nulo para lead só com telefone (WhatsApp) e após anonimização
    phone TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    utm TEXT NOT NULL DEFAULT '',
    consent BOOLEAN NOT NULL DEFAULT FALSE,
    consent_basis TEXT CHECK (consent_basis IN ('consent', 'inbound_contact', 'import')),
    consent_at TIMESTAMPTZ,
    score INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    external_id TEXT,
    erased_at TIMESTAMPTZ,  -- LGPD: titular anonimizado; fora de toda listagem
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    UNIQUE (org_id, email),
    UNIQUE (org_id, external_id)
);

CREATE TABLE IF NOT EXISTS lead_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    dedupe_key TEXT,  -- id da mensagem do WhatsApp: reentrega não duplica
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS copy_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    icp_id UUID NOT NULL REFERENCES icp_profiles(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    tone TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    citations TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'in_review', 'approved', 'rejected')),
    version INTEGER NOT NULL DEFAULT 1,
    embedding VECTOR(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'closer', 'copy')),
    password_hash TEXT NOT NULL,  -- scrypt
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,  -- sha256 do token; o token só existe no cookie
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS billable_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('lead_qualified', 'copy_approved', 'deal_won')),
    ref_id TEXT NOT NULL,  -- sem FK: sobrevive à anonimização do lead
    actor TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    UNIQUE (org_id, kind, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_org ON leads(org_id, stage);
CREATE INDEX IF NOT EXISTS idx_logs_org ON agent_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_billable_org ON billable_events(org_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_events_dedupe ON lead_events(org_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_logs_embedding_idx ON agent_logs USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE icp_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE copy_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billable_events ENABLE ROW LEVEL SECURITY;
