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

export type NodeType = "Sequence" | "HitEndpoint" | "Sleep" | "SendEmail";

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

export type WorkflowNode = SequenceNode | HitEndpointNode | SleepNode | SendEmailNode;

export interface WorkflowDefinition {
  name: string;
  root: WorkflowNode;
}
