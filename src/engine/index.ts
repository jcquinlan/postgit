import type { WorkflowNode, StepResult, Patch, Ref, ForEachNode, KVGetNode, KVSetNode, FailForNode } from "../sdk/types";
import { isRef } from "../sdk";
import type { WorkflowStepRow } from "../db";
import { kvGet, kvSet } from "../db";

export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.replace(/^\$\.?/, "").split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (part === "") continue;
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
    if (part === "") continue;
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

export interface NextNodeResult {
  node: WorkflowNode;
  nodeId: string;  // The effective node ID (may include loop prefix)
  blackboard: Record<string, unknown>;  // Blackboard with loop context
}

export function findNextNode(
  node: WorkflowNode,
  steps: Map<string, WorkflowStepRow>,
  blackboard: Record<string, unknown>,
  idPrefix: string = ""
): NextNodeResult | null {
  const effectiveId = idPrefix ? `${idPrefix}.${node.id}` : node.id;
  const step = steps.get(effectiveId);

  if (node.type === "Sequence") {
    for (const child of node.children) {
      const result = findNextNode(child, steps, blackboard, idPrefix);
      if (result) return result;
    }
    return null;
  }

  if (node.type === "ForEach") {
    return findNextInForEach(node, steps, blackboard, effectiveId);
  }

  if (!step || step.status !== "succeeded") {
    return { node, nodeId: effectiveId, blackboard };
  }

  return null;
}

function findNextInForEach(
  node: ForEachNode,
  steps: Map<string, WorkflowStepRow>,
  blackboard: Record<string, unknown>,
  loopId: string
): NextNodeResult | null {
  const itemsRef = node.props.items;
  const items = resolveRef(itemsRef, blackboard) as unknown[];

  if (!Array.isArray(items)) {
    console.error(`ForEach items is not an array:`, items);
    return null;
  }

  for (let i = 0; i < items.length; i++) {
    const iterationPrefix = `${loopId}[${i}]`;
    
    // Check if this iteration is complete
    const iterationComplete = node.children.every((child) => {
      const childId = `${iterationPrefix}.${child.id}`;
      const childStep = steps.get(childId);
      return childStep?.status === "succeeded";
    });

    if (!iterationComplete) {
      // Set up blackboard with current item
      const iterationBlackboard = {
        ...blackboard,
        __item: items[i],
        __index: i,
      };

      // Find the next node within this iteration
      for (const child of node.children) {
        const result = findNextNode(child, steps, iterationBlackboard, iterationPrefix);
        if (result) return result;
      }
    }
  }

  return null;
}

export function isSequenceComplete(
  node: WorkflowNode,
  steps: Map<string, WorkflowStepRow>,
  blackboard: Record<string, unknown>,
  idPrefix: string = ""
): boolean {
  const effectiveId = idPrefix ? `${idPrefix}.${node.id}` : node.id;

  if (node.type === "Sequence") {
    return node.children.every((child) =>
      isSequenceComplete(child, steps, blackboard, idPrefix)
    );
  }

  if (node.type === "ForEach") {
    return isForEachComplete(node, steps, blackboard, effectiveId);
  }

  const step = steps.get(effectiveId);
  return step?.status === "succeeded";
}

function isForEachComplete(
  node: ForEachNode,
  steps: Map<string, WorkflowStepRow>,
  blackboard: Record<string, unknown>,
  loopId: string
): boolean {
  const itemsRef = node.props.items;
  const items = resolveRef(itemsRef, blackboard) as unknown[];

  if (!Array.isArray(items)) {
    return true; // If items is not an array, consider it complete (error case)
  }

  for (let i = 0; i < items.length; i++) {
    const iterationPrefix = `${loopId}[${i}]`;
    
    const iterationComplete = node.children.every((child) => {
      const iterationBlackboard = { ...blackboard, __item: items[i], __index: i };
      return isSequenceComplete(child, steps, iterationBlackboard, iterationPrefix);
    });

    if (!iterationComplete) {
      return false;
    }
  }

  return true;
}

export async function executeNode(
  node: WorkflowNode,
  blackboard: Record<string, unknown>,
  instanceId: string,
  attempts: number = 1
): Promise<StepResult> {
  switch (node.type) {
    case "HitEndpoint":
      return executeHitEndpoint(node.props, blackboard);
    case "Sleep":
      return executeSleep(node.props);
    case "SendEmail":
      return executeSendEmail(node.props, blackboard);
    case "KVGet":
      return executeKVGet(node as KVGetNode, blackboard);
    case "KVSet":
      return executeKVSet(node as KVSetNode, blackboard);
    case "FailFor":
      return executeFailFor(node as FailForNode, attempts);
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

async function executeKVGet(
  node: KVGetNode,
  blackboard: Record<string, unknown>
): Promise<StepResult> {
  try {
    const { store, key, assignTo } = node.props;
    const resolvedKey = resolveRef(key, blackboard) as string;
    
    const value = await kvGet(store, resolvedKey);
    
    console.log(`🗄️  KV GET: ${store}["${resolvedKey}"] = ${JSON.stringify(value)}`);
    
    return {
      kind: "success",
      patch: [{ op: "set", path: assignTo, value }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "fail", error: `KVGet failed: ${message}` };
  }
}

async function executeKVSet(
  node: KVSetNode,
  blackboard: Record<string, unknown>
): Promise<StepResult> {
  try {
    const { store, key, value } = node.props;
    const resolvedKey = resolveRef(key, blackboard) as string;
    const resolvedValue = resolveRef(value, blackboard);
    
    await kvSet(store, resolvedKey, resolvedValue);
    
    console.log(`🗄️  KV SET: ${store}["${resolvedKey}"] = ${JSON.stringify(resolvedValue)}`);
    
    return { kind: "success" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "fail", error: `KVSet failed: ${message}` };
  }
}

function executeFailFor(node: FailForNode, attempts: number): StepResult {
  const { times } = node.props;
  
  if (attempts <= times) {
    console.log(`💥 FAIL FOR: Intentionally failing (attempt ${attempts}/${times})`);
    return { kind: "fail", error: `Intentional failure (attempt ${attempts} of ${times})` };
  }
  
  console.log(`✅ FAIL FOR: Success after ${times} intentional failures`);
  return { kind: "success" };
}
