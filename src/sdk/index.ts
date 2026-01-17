import type { Ref, WorkflowNode, SequenceNode, HitEndpointNode, SleepNode, SendEmailNode } from "./types";

export * from "./types";

export function ref(path: string): Ref {
  return { __ref: true, path };
}

export function isRef(value: unknown): value is Ref {
  return typeof value === "object" && value !== null && "__ref" in value && (value as Ref).__ref === true;
}

interface SequenceProps {
  id: string;
  children: WorkflowNode | WorkflowNode[];
}

export function Sequence(props: SequenceProps): SequenceNode {
  const children = Array.isArray(props.children) ? props.children : [props.children];
  return {
    type: "Sequence",
    id: props.id,
    props: {},
    children,
  };
}

interface HitEndpointProps {
  id: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  assignTo: string;
}

export function HitEndpoint(props: HitEndpointProps): HitEndpointNode {
  return {
    type: "HitEndpoint",
    id: props.id,
    props: {
      url: props.url,
      method: props.method,
      headers: props.headers,
      body: props.body,
      assignTo: props.assignTo,
    },
  };
}

interface SleepProps {
  id: string;
  seconds: number;
}

export function Sleep(props: SleepProps): SleepNode {
  return {
    type: "Sleep",
    id: props.id,
    props: {
      seconds: props.seconds,
    },
  };
}

interface SendEmailProps {
  id: string;
  to: string | Ref;
  subject: string | Ref;
  body: string | Ref;
}

export function SendEmail(props: SendEmailProps): SendEmailNode {
  return {
    type: "SendEmail",
    id: props.id,
    props: {
      to: props.to,
      subject: props.subject,
      body: props.body,
    },
  };
}
