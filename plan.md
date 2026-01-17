MVP Implementation Plan: Durable TSX Workflow Engine (Behavior Tree / Sequence)
Goal (single end-to-end demo)

User writes a TSX workflow, deploys it, runs an instance, and the backend durably executes:

HitEndpoint

Sleep(30s)

SendEmail (MVP may log instead of sending)

Durability requirement: if the worker process crashes mid-run, the instance resumes and finishes (at-least-once execution; side-effect nodes must be idempotent via (instance_id, node_id)).

A) Workflow SDK (authoring primitives)
Purpose

Provide TSX components that build a declarative workflow tree (no side effects).

Deliverables

@dc/sdk package exporting:

Sequence (composite node)

HitEndpoint, Sleep, SendEmail (leaf nodes)

Ref helper for referencing blackboard (ref("$.path"))

Runtime behavior

These components return plain JS objects (“elements”) that the CLI can serialize into an AST.

Interface (conceptual)

All nodes require stable id: string

All props must be JSON-serializable

Leaf props may include Ref values

Example user file:

import { Sequence, HitEndpoint, Sleep, SendEmail, ref } from "@dc/sdk";

export function workflow() {
  return (
    <Sequence id="root">
      <HitEndpoint id="hit" url="https://example.com/data" assignTo="$.hit" />
      <Sleep id="sleep" seconds={30} />
      <SendEmail
        id="email"
        to="me@example.com"
        subject="Demo"
        body={ref("$.hit.body")}
      />
    </Sequence>
  );
}

B) CLI (compile → validate → deploy → run)
Purpose

Turn TSX into a JSON workflow definition, upload it, then create an instance.

Commands

dc deploy <path/to/workflow.tsx> --name <name>

dc run <name> --input <optional.json>

Responsibilities

Compile TSX (esbuild/tsc) and evaluate the module in Node to obtain the root element from export function workflow().

Convert element tree → JSON AST:

enforce unique ids

enforce supported node types

ensure props JSON-serializable

Upload definition to backend:

POST /workflows with { name, definitionJson }

Create instance:

POST /workflows/:name/instances with { inputBlackboardJson }

Output

Prints workflow/instance IDs and status URLs.

C) Backend API (definitions + instances)
Purpose

Store workflow definitions and create runnable workflow instances.

Endpoints

POST /workflows

input: { name: string, definition: WorkflowDefinitionJson }

output: { workflowId }

POST /workflows/:name/instances

input: { input?: json }

output: { instanceId }

Optional (for debugging):

GET /instances/:id (status + blackboard + step statuses)

Persistence

Use Postgres only.

D) Persistence Model (Postgres)
Core concept

Durable execution is represented as:

a workflow definition (AST)

a workflow instance (blackboard + scheduling + lease)

per-node step state (status, attempts, outputs)

Tables (minimum)

workflow_definitions

id uuid pk

name text unique

definition_json jsonb

timestamps

workflow_instances

id uuid pk

definition_id uuid fk

status text (runnable|completed|failed)

blackboard jsonb

next_run_at timestamptz

lease_owner text null

lease_until timestamptz null

timestamps

workflow_steps

instance_id uuid fk

node_id text

status text (pending|succeeded|failed)

attempts int

last_error text null

timestamps

pk (instance_id, node_id)

E) Execution Engine (interpreter + node handlers)
Purpose

Given (definition AST + instance state), determine the next leaf node to execute and apply results durably.

Execution model

Only support Sequence composite in MVP.

Rule: in a Sequence, execute the first child whose step status is not succeeded.

Leaf execution returns a StepResult that updates blackboard + schedules next run.

Interfaces
StepResult
type StepResult =
  | { kind: "success"; patch?: Patch[] }
  | { kind: "wait"; nextRunAtMs: number; patch?: Patch[] }
  | { kind: "fail"; error: string; retryAtMs?: number; patch?: Patch[] };

type Patch =
  | { op: "set"; path: string; value: any }
  | { op: "merge"; path: string; value: any }
  | { op: "del"; path: string };

Ref resolution

Ref values are resolved against the instance blackboard at runtime before handler execution.

Node handlers (MVP)

HitEndpoint

inputs: url, method?, headers?, body?, assignTo (blackboard JSONPath-like string)

behavior: perform HTTP request with strict timeouts/size caps

returns: success + patch setting response under assignTo

idempotency: include (instance_id,node_id) as an idempotency key in stored step record; if step already succeeded, skip execution.

Sleep

inputs: seconds

returns: wait with nextRunAt = now + seconds*1000

SendEmail

MVP: log to stdout (or store a “sent” record) rather than actual email integration

inputs: to, subject, body (strings or Refs)

returns: success

idempotency: same (instance_id,node_id) key; ensure only one “send” per node.

F) Worker (polling + leasing + retries)
Purpose

Continuously claim due instances, execute one step, persist state, repeat.

Loop

Claim one due instance with an atomic lease (Postgres).

Load workflow definition + instance blackboard + step states.

Engine picks next leaf node to run (or completes instance).

Execute handler, apply patches, update step state.

Update instance:

on wait: next_run_at = nextRunAt, status=runnable

on success (and sequence finished): status=completed

on fail: apply retry policy (below)

Release/expire lease by setting lease_until = null (or let it expire).

Leasing (critical)

Atomic “claim next runnable” query:

select workflow_instances where status='runnable' AND next_run_at <= now AND (lease_until is null OR lease_until < now)

FOR UPDATE SKIP LOCKED

set lease_until = now + leaseMs, lease_owner = workerId

Retry policy (MVP)

Per-leaf-node attempts stored in workflow_steps.attempts

On failure:

if attempts < 3: schedule instance next_run_at = now + backoff(attempts) and keep status=runnable

else: mark instance failed

Sleep strategy when idle

If no instance claimed, query min(next_run_at) and sleep until then (cap to e.g. 5s) + jitter.

End-to-End Test Plan (what proves MVP works)

Author workflow.tsx with Sequence(HitEndpoint -> Sleep(30) -> SendEmail/log).

dc deploy workflow.tsx --name demo

dc run demo

Worker executes:

HitEndpoint writes response into blackboard

Sleep schedules instance for +30s

After 30s, resumes and “sends” email/logs, marks completed

Crash test:

kill worker after step 1 or 2, restart worker

instance resumes based on persisted workflow_steps + next_run_at

Non-goals for MVP (explicit)

No arbitrary user code nodes

No Selector/Parallel nodes

No real email provider integration (log is sufficient)

No multi-tenant isolation concerns beyond basic safety/timeouts

No UI

This plan yields a small, testable system where TSX compiles to a durable, resumable execution of ordered steps with a shared persisted blackboard.