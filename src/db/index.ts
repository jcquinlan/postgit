import { SQL } from "bun";
import type { WorkflowNode } from "../sdk/types";

const sql = new SQL({
  url: process.env.DATABASE_URL,
});

export interface WorkflowDefinitionRow {
  id: string;
  name: string;
  definition_json: WorkflowNode;
  created_at: Date;
  updated_at: Date;
}

export interface WorkflowInstanceRow {
  id: string;
  definition_id: string;
  status: "runnable" | "completed" | "failed";
  blackboard: Record<string, unknown>;
  next_run_at: Date;
  lease_owner: string | null;
  lease_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkflowStepRow {
  instance_id: string;
  node_id: string;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  last_error: string | null;
  output: unknown;
  created_at: Date;
  updated_at: Date;
}

export async function initDb() {
  const schemaFile = Bun.file(new URL("./schema.sql", import.meta.url).pathname);
  const schema = await schemaFile.text();
  await sql.unsafe(schema);
}

export async function createWorkflowDefinition(
  name: string,
  definitionJson: WorkflowNode
): Promise<string> {
  const result = await sql`
    INSERT INTO workflow_definitions (name, definition_json)
    VALUES (${name}, ${definitionJson}::jsonb)
    ON CONFLICT (name) DO UPDATE SET
      definition_json = EXCLUDED.definition_json,
      updated_at = NOW()
    RETURNING id
  `;
  return result[0].id;
}

function parseJsonb<T>(value: T | string): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      // Value is a plain string, not a JSON structure
      return value as T;
    }
  }
  return value;
}

function parseDefinitionRow(row: Record<string, unknown>): WorkflowDefinitionRow {
  return {
    ...row,
    definition_json: parseJsonb(row.definition_json),
  } as WorkflowDefinitionRow;
}

export async function getWorkflowDefinitionByName(
  name: string
): Promise<WorkflowDefinitionRow | null> {
  const result = await sql`
    SELECT * FROM workflow_definitions WHERE name = ${name}
  `;
  return result[0] ? parseDefinitionRow(result[0]) : null;
}

export async function getWorkflowDefinitionById(
  id: string
): Promise<WorkflowDefinitionRow | null> {
  const result = await sql`
    SELECT * FROM workflow_definitions WHERE id = ${id}::uuid
  `;
  return result[0] ? parseDefinitionRow(result[0]) : null;
}

export async function createWorkflowInstance(
  definitionId: string,
  inputBlackboard: Record<string, unknown> = {}
): Promise<string> {
  const result = await sql`
    INSERT INTO workflow_instances (definition_id, blackboard)
    VALUES (${definitionId}::uuid, ${inputBlackboard}::jsonb)
    RETURNING id
  `;
  return result[0].id;
}

function parseInstanceRow(row: Record<string, unknown>): WorkflowInstanceRow {
  return {
    ...row,
    blackboard: parseJsonb(row.blackboard as Record<string, unknown>),
  } as WorkflowInstanceRow;
}

function parseStepRow(row: Record<string, unknown>): WorkflowStepRow {
  return {
    ...row,
    output: row.output ? parseJsonb(row.output) : null,
  } as WorkflowStepRow;
}

export async function getWorkflowInstance(
  id: string
): Promise<WorkflowInstanceRow | null> {
  const result = await sql`
    SELECT * FROM workflow_instances WHERE id = ${id}::uuid
  `;
  return result[0] ? parseInstanceRow(result[0]) : null;
}

export async function getWorkflowSteps(
  instanceId: string
): Promise<WorkflowStepRow[]> {
  const result = await sql`
    SELECT * FROM workflow_steps WHERE instance_id = ${instanceId}::uuid
  `;
  return result.map(parseStepRow);
}

export async function getOrCreateStep(
  instanceId: string,
  nodeId: string
): Promise<WorkflowStepRow> {
  const result = await sql`
    INSERT INTO workflow_steps (instance_id, node_id)
    VALUES (${instanceId}::uuid, ${nodeId})
    ON CONFLICT (instance_id, node_id) DO UPDATE SET
      updated_at = NOW()
    RETURNING *
  `;
  return parseStepRow(result[0]);
}

export async function updateStepSuccess(
  instanceId: string,
  nodeId: string,
  output?: unknown
): Promise<void> {
  await sql`
    UPDATE workflow_steps
    SET status = 'succeeded',
        attempts = attempts + 1,
        output = ${output ?? null}::jsonb,
        updated_at = NOW()
    WHERE instance_id = ${instanceId}::uuid AND node_id = ${nodeId}
  `;
}

export async function updateStepFailed(
  instanceId: string,
  nodeId: string,
  error: string
): Promise<void> {
  await sql`
    UPDATE workflow_steps
    SET status = 'failed',
        attempts = attempts + 1,
        last_error = ${error},
        updated_at = NOW()
    WHERE instance_id = ${instanceId}::uuid AND node_id = ${nodeId}
  `;
}

export async function incrementStepAttempts(
  instanceId: string,
  nodeId: string
): Promise<number> {
  const result = await sql`
    UPDATE workflow_steps
    SET attempts = attempts + 1, updated_at = NOW()
    WHERE instance_id = ${instanceId}::uuid AND node_id = ${nodeId}
    RETURNING attempts
  `;
  return result[0].attempts;
}

export async function claimNextInstance(
  workerId: string,
  leaseMs: number = 30000
): Promise<WorkflowInstanceRow | null> {
  const result = await sql`
    UPDATE workflow_instances
    SET lease_owner = ${workerId},
        lease_until = NOW() + (${leaseMs} || ' milliseconds')::interval,
        updated_at = NOW()
    WHERE id = (
      SELECT id FROM workflow_instances
      WHERE status = 'runnable'
        AND next_run_at <= NOW()
        AND (lease_until IS NULL OR lease_until < NOW())
      ORDER BY next_run_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
  return result[0] ? parseInstanceRow(result[0]) : null;
}

export async function updateInstanceBlackboard(
  instanceId: string,
  blackboard: Record<string, unknown>
): Promise<void> {
  await sql`
    UPDATE workflow_instances
    SET blackboard = ${blackboard}::jsonb,
        updated_at = NOW()
    WHERE id = ${instanceId}::uuid
  `;
}

export async function updateInstanceStatus(
  instanceId: string,
  status: "runnable" | "completed" | "failed",
  nextRunAt?: Date
): Promise<void> {
  await sql`
    UPDATE workflow_instances
    SET status = ${status},
        next_run_at = ${nextRunAt ?? null},
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = NOW()
    WHERE id = ${instanceId}::uuid
  `;
}

export async function releaseInstanceLease(instanceId: string): Promise<void> {
  await sql`
    UPDATE workflow_instances
    SET lease_owner = NULL,
        lease_until = NULL,
        updated_at = NOW()
    WHERE id = ${instanceId}::uuid
  `;
}

export async function getNextRunTime(): Promise<Date | null> {
  const result = await sql`
    SELECT MIN(next_run_at) as next_run_at
    FROM workflow_instances
    WHERE status = 'runnable'
  `;
  return result[0]?.next_run_at ?? null;
}

export async function listWorkflowDefinitions(): Promise<WorkflowDefinitionRow[]> {
  return sql`
    SELECT * FROM workflow_definitions
    ORDER BY created_at DESC
  `;
}

export async function listWorkflowInstances(
  status?: string,
  workflowName?: string
): Promise<(WorkflowInstanceRow & { workflow_name: string })[]> {
  if (status && workflowName) {
    return sql`
      SELECT i.*, d.name as workflow_name
      FROM workflow_instances i
      JOIN workflow_definitions d ON i.definition_id = d.id
      WHERE i.status = ${status} AND d.name = ${workflowName}
      ORDER BY i.created_at DESC
    `;
  } else if (status) {
    return sql`
      SELECT i.*, d.name as workflow_name
      FROM workflow_instances i
      JOIN workflow_definitions d ON i.definition_id = d.id
      WHERE i.status = ${status}
      ORDER BY i.created_at DESC
    `;
  } else if (workflowName) {
    return sql`
      SELECT i.*, d.name as workflow_name
      FROM workflow_instances i
      JOIN workflow_definitions d ON i.definition_id = d.id
      WHERE d.name = ${workflowName}
      ORDER BY i.created_at DESC
    `;
  }
  return sql`
    SELECT i.*, d.name as workflow_name
    FROM workflow_instances i
    JOIN workflow_definitions d ON i.definition_id = d.id
    ORDER BY i.created_at DESC
  `;
}

export async function getInstanceStats(): Promise<{
  total: number;
  runnable: number;
  completed: number;
  failed: number;
}> {
  const result = await sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'runnable') as runnable,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) FILTER (WHERE status = 'failed') as failed
    FROM workflow_instances
  `;
  return {
    total: Number(result[0].total),
    runnable: Number(result[0].runnable),
    completed: Number(result[0].completed),
    failed: Number(result[0].failed),
  };
}

export async function deleteWorkflowDefinition(name: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM workflow_definitions WHERE name = ${name}
    RETURNING id
  `;
  return result.length > 0;
}

export async function deleteWorkflowInstance(id: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM workflow_instances WHERE id = ${id}::uuid
    RETURNING id
  `;
  return result.length > 0;
}

export async function resetInstance(id: string): Promise<boolean> {
  const result = await sql`
    UPDATE workflow_instances
    SET status = 'runnable',
        next_run_at = NOW(),
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = NOW()
    WHERE id = ${id}::uuid
    RETURNING id
  `;
  if (result.length > 0) {
    await sql`
      UPDATE workflow_steps
      SET status = 'pending', attempts = 0, last_error = NULL
      WHERE instance_id = ${id}::uuid
    `;
    return true;
  }
  return false;
}

export async function kvGet(
  storeName: string,
  key: string
): Promise<unknown> {
  const result = await sql`
    SELECT value FROM workflow_kv
    WHERE store_name = ${storeName} AND key = ${key}
  `;
  if (result.length === 0) {
    return undefined;
  }
  return parseJsonb(result[0].value);
}

export async function kvSet(
  storeName: string,
  key: string,
  value: unknown
): Promise<void> {
  await sql`
    INSERT INTO workflow_kv (store_name, key, value)
    VALUES (${storeName}, ${key}, ${value}::jsonb)
    ON CONFLICT (store_name, key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()
  `;
}

export async function kvDelete(
  storeName: string,
  key: string
): Promise<boolean> {
  const result = await sql`
    DELETE FROM workflow_kv
    WHERE store_name = ${storeName} AND key = ${key}
    RETURNING key
  `;
  return result.length > 0;
}

export async function kvList(
  storeName: string
): Promise<Array<{ key: string; value: unknown }>> {
  const result = await sql`
    SELECT key, value FROM workflow_kv
    WHERE store_name = ${storeName}
    ORDER BY key
  `;
  return result.map((row: { key: string; value: unknown }) => ({
    key: row.key,
    value: parseJsonb(row.value),
  }));
}

export { sql };
