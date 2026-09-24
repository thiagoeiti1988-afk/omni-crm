-- Omni-CRM Core Schema with pgvector
-- Enable pgvector extension for RAG capabilities
CREATE EXTENSION IF NOT EXISTS vector;

-- Projects Table (Macro)
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    platform TEXT, -- e.g., 'Codex', 'OpenClaw', 'Cursor'
    status TEXT DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Tasks Table (Quanta)
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo'
        CHECK (status IN ('todo', 'in_progress', 'in_review', 'done')),
    assigned_agent TEXT, -- e.g., 'Claude-3.5-Sonnet', 'Grok'
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Mantém updated_at consistente em todo UPDATE (agentes não podem esquecer).
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Agent Logs Table (Memory & Auditing)
CREATE TABLE agent_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL, -- Which agent executed this
    action_type TEXT NOT NULL, -- e.g., 'CODE_COMMIT', 'PLANNING', 'ERROR'
    log_content TEXT NOT NULL,
    embedding VECTOR(1536), -- Vector representation of the log content for RAG
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Indexes for performance (JEV optimization)
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_logs_task ON agent_logs(task_id);
CREATE INDEX idx_logs_project ON agent_logs(project_id);

-- HNSW Index for vector search (assuming pgvector >= 0.5.0)
CREATE INDEX agent_logs_embedding_idx ON agent_logs USING hnsw (embedding vector_cosine_ops);
