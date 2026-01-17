import {
  createWorkflowDefinition,
  getWorkflowDefinitionByName,
  createWorkflowInstance,
  getWorkflowInstance,
  getWorkflowSteps,
  getWorkflowDefinitionById,
  listWorkflowDefinitions,
  listWorkflowInstances,
  getInstanceStats,
  deleteWorkflowDefinition,
  deleteWorkflowInstance,
  resetInstance,
} from "../db";
import type { WorkflowNode } from "../sdk/types";

interface CreateWorkflowBody {
  name: string;
  definition: WorkflowNode;
}

interface CreateInstanceBody {
  input?: Record<string, unknown>;
}

export function createApiRoutes() {
  return {
    "POST /api/workflows": async (req: Request) => {
      try {
        const body = (await req.json()) as CreateWorkflowBody;

        if (!body.name || !body.definition) {
          return Response.json(
            { error: "name and definition are required" },
            { status: 400 }
          );
        }

        const workflowId = await createWorkflowDefinition(body.name, body.definition);
        return Response.json({ workflowId });
      } catch (error) {
        console.error("Failed to create workflow:", error);
        return Response.json(
          { error: "Failed to create workflow" },
          { status: 500 }
        );
      }
    },

    "GET /api/workflows": async () => {
      try {
        const workflows = await listWorkflowDefinitions();
        return Response.json({
          workflows: workflows.map((w) => ({
            id: w.id,
            name: w.name,
            createdAt: w.created_at,
            updatedAt: w.updated_at,
          })),
        });
      } catch (error) {
        console.error("Failed to list workflows:", error);
        return Response.json(
          { error: "Failed to list workflows" },
          { status: 500 }
        );
      }
    },

    "GET /api/workflows/:name": async (req: Request) => {
      try {
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const name = pathParts[3];

        const definition = await getWorkflowDefinitionByName(name);
        if (!definition) {
          return Response.json(
            { error: `Workflow '${name}' not found` },
            { status: 404 }
          );
        }

        return Response.json({
          id: definition.id,
          name: definition.name,
          definition: definition.definition_json,
          createdAt: definition.created_at,
          updatedAt: definition.updated_at,
        });
      } catch (error) {
        console.error("Failed to get workflow:", error);
        return Response.json(
          { error: "Failed to get workflow" },
          { status: 500 }
        );
      }
    },

    "DELETE /api/workflows/:name": async (req: Request) => {
      try {
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const name = pathParts[3];

        const deleted = await deleteWorkflowDefinition(name);
        if (!deleted) {
          return Response.json(
            { error: `Workflow '${name}' not found` },
            { status: 404 }
          );
        }

        return Response.json({ deleted: true });
      } catch (error) {
        console.error("Failed to delete workflow:", error);
        return Response.json(
          { error: "Failed to delete workflow" },
          { status: 500 }
        );
      }
    },

    "POST /api/workflows/:name/instances": async (req: Request) => {
      try {
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const name = pathParts[3];

        const definition = await getWorkflowDefinitionByName(name);
        if (!definition) {
          return Response.json(
            { error: `Workflow '${name}' not found` },
            { status: 404 }
          );
        }

        let input: Record<string, unknown> = {};
        try {
          const body = (await req.json()) as CreateInstanceBody;
          input = body.input ?? {};
        } catch {
          // No body provided, use empty input
        }

        const instanceId = await createWorkflowInstance(definition.id, input);
        return Response.json({ instanceId });
      } catch (error) {
        console.error("Failed to create instance:", error);
        return Response.json(
          { error: "Failed to create instance" },
          { status: 500 }
        );
      }
    },

    "GET /api/instances": async (req: Request) => {
      try {
        const url = new URL(req.url);
        const status = url.searchParams.get("status") ?? undefined;
        const workflow = url.searchParams.get("workflow") ?? undefined;

        const instances = await listWorkflowInstances(status, workflow);
        const stats = await getInstanceStats();

        return Response.json({
          stats,
          instances: instances.map((i) => ({
            id: i.id,
            workflow: i.workflow_name,
            status: i.status,
            nextRunAt: i.next_run_at,
            leaseOwner: i.lease_owner,
            createdAt: i.created_at,
            updatedAt: i.updated_at,
          })),
        });
      } catch (error) {
        console.error("Failed to list instances:", error);
        return Response.json(
          { error: "Failed to list instances" },
          { status: 500 }
        );
      }
    },

    "GET /api/instances/:id": async (req: Request) => {
      try {
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const id = pathParts[3];

        const instance = await getWorkflowInstance(id);
        if (!instance) {
          return Response.json(
            { error: `Instance '${id}' not found` },
            { status: 404 }
          );
        }

        const steps = await getWorkflowSteps(id);
        const definition = await getWorkflowDefinitionById(instance.definition_id);

        return Response.json({
          instance: {
            id: instance.id,
            status: instance.status,
            blackboard: instance.blackboard,
            nextRunAt: instance.next_run_at,
            leaseOwner: instance.lease_owner,
            leaseUntil: instance.lease_until,
            createdAt: instance.created_at,
            updatedAt: instance.updated_at,
          },
          steps: steps.map((s) => ({
            nodeId: s.node_id,
            status: s.status,
            attempts: s.attempts,
            lastError: s.last_error,
            output: s.output,
          })),
          definition: definition?.definition_json,
        });
      } catch (error) {
        console.error("Failed to get instance:", error);
        return Response.json(
          { error: "Failed to get instance" },
          { status: 500 }
        );
      }
    },

    "DELETE /api/instances/:id": async (req: Request) => {
      try {
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const id = pathParts[3];

        const deleted = await deleteWorkflowInstance(id);
        if (!deleted) {
          return Response.json(
            { error: `Instance '${id}' not found` },
            { status: 404 }
          );
        }

        return Response.json({ deleted: true });
      } catch (error) {
        console.error("Failed to delete instance:", error);
        return Response.json(
          { error: "Failed to delete instance" },
          { status: 500 }
        );
      }
    },

    "POST /api/instances/:id/reset": async (req: Request) => {
      try {
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const id = pathParts[3];

        const reset = await resetInstance(id);
        if (!reset) {
          return Response.json(
            { error: `Instance '${id}' not found` },
            { status: 404 }
          );
        }

        return Response.json({ reset: true });
      } catch (error) {
        console.error("Failed to reset instance:", error);
        return Response.json(
          { error: "Failed to reset instance" },
          { status: 500 }
        );
      }
    },
  };
}
