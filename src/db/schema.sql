CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT UNIQUE NOT NULL,
  definition_json JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_instances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  definition_id UUID NOT NULL REFERENCES workflow_definitions(id),
  status TEXT NOT NULL DEFAULT 'runnable' CHECK (status IN ('runnable', 'completed', 'failed')),
  blackboard JSONB NOT NULL DEFAULT '{}',
  next_run_at TIMESTAMPTZ DEFAULT NOW(),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  instance_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  output JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (instance_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_instances_runnable ON workflow_instances(next_run_at)
  WHERE status = 'runnable';

CREATE INDEX IF NOT EXISTS idx_instances_lease ON workflow_instances(lease_until)
  WHERE lease_until IS NOT NULL;
