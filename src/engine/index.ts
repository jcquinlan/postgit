import type { WorkflowNode, StepResult, Patch, Ref } from "../sdk/types";
import { isRef } from "../sdk";
import type { WorkflowStepRow } from "../db";

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.replace(/^\$\.?/, "").split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.replace(/^\$\.?/, "").split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function deleteByPath(obj: Record<string, unknown>, path: string): void {
  const parts = path.replace(/^\$\.?/, "").split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current)) return;
    current = current[part] as Record<string, unknown>;
  }
  delete current[parts[parts.length - 1]];
}

export function resolveRef(
  value: unknown,
  blackboard: Record<string, unknown>
): unknown {
  if (isRef(value)) {
    return getByPath(blackboard, value.path);
  }
  return value;
}

export function applyPatches(
  blackboard: Record<string, unknown>,
  patches: Patch[]
): Record<string, unknown> {
  const result = structuredClone(blackboard);
  for (const patch of patches) {
    switch (patch.op) {
      case "set":
        setByPath(result, patch.path, patch.value);
        break;
      case "merge":
        const existing = getByPath(result, patch.path) ?? {};
        if (typeof existing === "object" && existing !== null) {
          setByPath(result, patch.path, { ...existing, ...patch.value });
        } else {
          setByPath(result, patch.path, patch.value);
        }
        break;
      case "del":
        deleteByPath(result, patch.path);
        break;
    }
  }
  return result;
}

export function findNextNode(
  node: WorkflowNode,
  steps: Map<string, WorkflowStepRow>
): WorkflowNode | null {
  const step = steps.get(node.id);

  if (node.type === "Sequence") {
    for (const child of node.children) {
      const childStep = steps.get(child.id);
      if (!childStep || childStep.status !== "succeeded") {
        const result = findNextNode(child, steps);
        if (result) return result;
      }
    }
    return null;
  }

  if (!step || step.status !== "succeeded") {
    return node;
  }

  return null;
}

export function isSequenceComplete(
  node: WorkflowNode,
  steps: Map<string, WorkflowStepRow>
): boolean {
  if (node.type === "Sequence") {
    return node.children.every((child) => isSequenceComplete(child, steps));
  }

  const step = steps.get(node.id);
  return step?.status === "succeeded";
}

export async function executeNode(
  node: WorkflowNode,
  blackboard: Record<string, unknown>,
  instanceId: string
): Promise<StepResult> {
  switch (node.type) {
    case "HitEndpoint":
      return executeHitEndpoint(node.props, blackboard);
    case "Sleep":
      return executeSleep(node.props);
    case "SendEmail":
      return executeSendEmail(node.props, blackboard);
    default:
      return { kind: "fail", error: `Unknown node type: ${(node as WorkflowNode).type}` };
  }
}

async function executeHitEndpoint(
  props: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    assignTo: string;
  },
  blackboard: Record<string, unknown>
): Promise<StepResult> {
  try {
    const url = resolveRef(props.url, blackboard) as string;
    const method = (resolveRef(props.method, blackboard) as string) ?? "GET";
    const reqHeaders = (resolveRef(props.headers, blackboard) as Record<string, string>) ?? {};
    const body = resolveRef(props.body, blackboard);

    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...reqHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });

    const responseText = await response.text();
    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    const resHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });

    const result = {
      status: response.status,
      statusText: response.statusText,
      headers: resHeaders,
      body: responseData,
    };

    return {
      kind: "success",
      patch: [{ op: "set", path: props.assignTo, value: result }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "fail", error: `HitEndpoint failed: ${message}` };
  }
}

function executeSleep(props: { seconds: number }): StepResult {
  const nextRunAtMs = Date.now() + props.seconds * 1000;
  return { kind: "wait", nextRunAtMs };
}

function executeSendEmail(
  props: { to: string | Ref; subject: string | Ref; body: string | Ref },
  blackboard: Record<string, unknown>
): StepResult {
  const to = resolveRef(props.to, blackboard) as string;
  const subject = resolveRef(props.subject, blackboard) as string;
  const body = resolveRef(props.body, blackboard) as string;

  console.log("═".repeat(60));
  console.log("📧 SEND EMAIL (MVP - logged only)");
  console.log("═".repeat(60));
  console.log(`To:      ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(`Body:    ${body}`);
  console.log("═".repeat(60));

  return { kind: "success" };
}
