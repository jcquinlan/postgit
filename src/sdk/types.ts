export type Ref = {
  __ref: true;
  path: string;
};

export type Patch =
  | { op: "set"; path: string; value: unknown }
  | { op: "merge"; path: string; value: Record<string, unknown> }
  | { op: "del"; path: string };

export type StepResult =
  | { kind: "success"; patch?: Patch[] }
  | { kind: "wait"; nextRunAtMs: number; patch?: Patch[] }
  | { kind: "fail"; error: string; retryAtMs?: number; patch?: Patch[] };

export type NodeType = "Sequence" | "ForEach" | "HitEndpoint" | "Sleep" | "SendEmail" | "KVGet" | "KVSet" | "FailFor";

export interface BaseNode {
  type: NodeType;
  id: string;
  props: Record<string, unknown>;
  children?: WorkflowNode[];
}

export interface SequenceNode extends BaseNode {
  type: "Sequence";
  children: WorkflowNode[];
}

export interface ForEachNode extends BaseNode {
  type: "ForEach";
  props: {
    items: string | Ref;    // blackboard path to array, or ref
    itemVar: string;        // variable name for current item (e.g., "user")
    indexVar?: string;      // optional variable name for index (e.g., "i")
  };
  children: WorkflowNode[];
}

export interface HitEndpointNode extends BaseNode {
  type: "HitEndpoint";
  props: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    assignTo: string;
  };
}

export interface SleepNode extends BaseNode {
  type: "Sleep";
  props: {
    seconds: number;
  };
}

export interface SendEmailNode extends BaseNode {
  type: "SendEmail";
  props: {
    to: string | Ref;
    subject: string | Ref;
    body: string | Ref;
  };
}

export interface KVGetNode extends BaseNode {
  type: "KVGet";
  props: {
    store: string;
    key: string | Ref;
    assignTo: string;
  };
}

export interface KVSetNode extends BaseNode {
  type: "KVSet";
  props: {
    store: string;
    key: string | Ref;
    value: unknown | Ref;
  };
}

export interface FailForNode extends BaseNode {
  type: "FailFor";
  props: {
    times: number;
  };
}

export type WorkflowNode = SequenceNode | ForEachNode | HitEndpointNode | SleepNode | SendEmailNode | KVGetNode | KVSetNode | FailForNode;

export interface WorkflowDefinition {
  name: string;
  root: WorkflowNode;
}
