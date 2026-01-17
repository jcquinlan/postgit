#!/usr/bin/env bun
import { Command } from "commander";
import { resolve } from "path";
import type { WorkflowNode } from "../sdk/types";
import { compileWorkflowFile } from "../compiler";

const API_URL = process.env.DC_API_URL ?? "http://localhost:3000";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function statusColor(status: string): string {
  switch (status) {
    case "runnable":
    case "pending":
      return c.yellow;
    case "completed":
    case "succeeded":
      return c.green;
    case "failed":
      return c.red;
    default:
      return c.reset;
  }
}

function formatDate(date: string | null): string {
  if (!date) return "-";
  return new Date(date).toLocaleString();
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len - 3) + "...";
}

async function compileWorkflow(filePath: string): Promise<WorkflowNode> {
  const absolutePath = resolve(process.cwd(), filePath);
  
  // Read the file to check if it uses DSL style (async function)
  const content = await Bun.file(absolutePath).text();
  const usesDsl = /export\s+async\s+function\s+workflow/.test(content);

  if (usesDsl) {
    // Use static analysis compiler for DSL-style workflows
    return compileWorkflowFile(absolutePath);
  }

  // Fall back to runtime evaluation for SDK-style workflows
  const module = await import(absolutePath);

  if (typeof module.workflow !== "function") {
    throw new Error(
      `Workflow file must export a 'workflow' function. Found: ${Object.keys(module).join(", ")}`
    );
  }

  const result = module.workflow();

  if (!result || typeof result !== "object" || !result.type || !result.id) {
    throw new Error("workflow() must return a valid workflow node");
  }

  return result as WorkflowNode;
}

function validateNode(node: WorkflowNode, seenIds: Set<string> = new Set()): void {
  if (seenIds.has(node.id)) {
    throw new Error(`Duplicate node id: ${node.id}`);
  }
  seenIds.add(node.id);

  const validTypes = ["Sequence", "ForEach", "HitEndpoint", "Sleep", "SendEmail", "KVGet", "KVSet", "FailFor"];
  if (!validTypes.includes(node.type)) {
    throw new Error(`Invalid node type: ${node.type}`);
  }

  if ((node.type === "Sequence" || node.type === "ForEach") && node.children) {
    for (const child of node.children) {
      validateNode(child, seenIds);
    }
  }
}

async function apiRequest(
  path: string,
  options?: RequestInit
): Promise<Response> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  return response;
}

const program = new Command();

program
  .name("postgit")
  .alias("pst")
  .description("Postgit - Durable workflow engine powered by Postgres")
  .version("0.1.0")
  .configureOutput({
    outputError: (str, write) => write(`${c.red}${str}${c.reset}`),
  });

program
  .command("deploy")
  .description("Deploy a workflow definition from a TypeScript file")
  .argument("<file>", "Path to workflow file (e.g., workflow.ts)")
  .argument("[name]", "Name for the workflow (defaults to filename)")
  .option("-q, --quiet", "Only output the workflow ID")
  .action(async (file: string, name: string | undefined, options: { quiet?: boolean }) => {
    const workflowName = name ?? file.replace(/^.*\//, "").replace(/\.[^.]+$/, "");

    if (!options.quiet) {
      console.log(`${c.dim}Compiling workflow from ${file}...${c.reset}`);
    }

    const definition = await compileWorkflow(file);
    validateNode(definition);

    if (!options.quiet) {
      console.log(`${c.dim}Deploying workflow '${workflowName}'...${c.reset}`);
    }

    const response = await apiRequest("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ name: workflowName, definition }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Deploy failed: ${response.status} ${error}`);
    }

    const result = (await response.json()) as { workflowId: string };

    if (options.quiet) {
      console.log(result.workflowId);
    } else {
      console.log(`${c.green}✓${c.reset} Deployed ${c.bold}${workflowName}${c.reset}`);
      console.log(`  ${c.dim}ID: ${result.workflowId}${c.reset}`);
    }
  });

program
  .command("run")
  .description("Create and start a new workflow instance")
  .argument("<workflow>", "Name of the deployed workflow")
  .option("-i, --input <file>", "JSON file with input blackboard data")
  .option("-q, --quiet", "Only output the instance ID")
  .option("-w, --watch", "Watch instance progress until completion")
  .action(async (workflow: string, options: { input?: string; quiet?: boolean; watch?: boolean }) => {
    let input: Record<string, unknown> = {};

    if (options.input) {
      const file = Bun.file(options.input);
      input = await file.json();
    }

    const response = await apiRequest(`/api/workflows/${workflow}/instances`, {
      method: "POST",
      body: JSON.stringify({ input }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Run failed: ${response.status} ${error}`);
    }

    const result = (await response.json()) as { instanceId: string };

    if (options.quiet) {
      console.log(result.instanceId);
    } else {
      console.log(`${c.green}✓${c.reset} Instance created: ${c.bold}${result.instanceId}${c.reset}`);
    }

    if (options.watch) {
      await watchInstance(result.instanceId);
    }
  });

async function watchInstance(instanceId: string): Promise<void> {
  console.log(`${c.dim}Watching instance ${instanceId}...${c.reset}`);
  console.log();

  let lastStatus = "";
  let lastStepStatuses: Record<string, string> = {};

  while (true) {
    const response = await apiRequest(`/api/instances/${instanceId}`);
    if (!response.ok) break;

    const data = (await response.json()) as {
      instance: { status: string; nextRunAt: string | null };
      steps: Array<{ nodeId: string; status: string; attempts: number; lastError: string | null }>;
    };

    if (data.instance.status !== lastStatus) {
      lastStatus = data.instance.status;
      const color = statusColor(lastStatus);
      console.log(`${c.dim}[${new Date().toLocaleTimeString()}]${c.reset} Instance: ${color}${lastStatus}${c.reset}`);
    }

    for (const step of data.steps) {
      if (step.status !== lastStepStatuses[step.nodeId]) {
        lastStepStatuses[step.nodeId] = step.status;
        const color = statusColor(step.status);
        console.log(`${c.dim}[${new Date().toLocaleTimeString()}]${c.reset} Step ${c.cyan}${step.nodeId}${c.reset}: ${color}${step.status}${c.reset}`);
        if (step.lastError) {
          console.log(`  ${c.red}└ ${step.lastError}${c.reset}`);
        }
      }
    }

    if (data.instance.status === "completed" || data.instance.status === "failed") {
      console.log();
      console.log(`${statusColor(data.instance.status)}Instance ${data.instance.status}${c.reset}`);
      break;
    }

    await Bun.sleep(1000);
  }
}

program
  .command("status")
  .description("Show detailed status of a workflow instance")
  .argument("<instance-id>", "Instance ID to inspect")
  .option("-j, --json", "Output raw JSON")
  .action(async (instanceId: string, options: { json?: boolean }) => {
    const response = await apiRequest(`/api/instances/${instanceId}`);

    if (!response.ok) {
      throw new Error(`Instance '${instanceId}' not found`);
    }

    const data = (await response.json()) as {
      instance: {
        id: string;
        status: string;
        blackboard: Record<string, unknown>;
        nextRunAt: string | null;
        leaseOwner: string | null;
        leaseUntil: string | null;
        createdAt: string;
        updatedAt: string;
      };
      steps: Array<{
        nodeId: string;
        status: string;
        attempts: number;
        lastError: string | null;
      }>;
      definition: WorkflowNode;
    };

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const { instance, steps, definition } = data;

    console.log();
    console.log(`${c.bold}Instance${c.reset} ${instance.id}`);
    console.log();
    console.log(`  Status:   ${statusColor(instance.status)}${instance.status}${c.reset}`);
    console.log(`  Created:  ${formatDate(instance.createdAt)}`);
    console.log(`  Updated:  ${formatDate(instance.updatedAt)}`);

    if (instance.nextRunAt) {
      console.log(`  Next Run: ${formatDate(instance.nextRunAt)}`);
    }
    if (instance.leaseOwner) {
      console.log(`  Lease:    ${instance.leaseOwner} until ${formatDate(instance.leaseUntil)}`);
    }

    console.log();
    console.log(`${c.bold}Steps${c.reset}`);
    console.log();

    function printNode(node: WorkflowNode, indent: number = 0) {
      const step = steps.find((s) => s.nodeId === node.id);
      const prefix = "  ".repeat(indent + 1);
      const stepStatus = step?.status ?? "pending";
      const attempts = step?.attempts ?? 0;
      const color = statusColor(stepStatus);

      console.log(
        `${prefix}${color}●${c.reset} ${node.id} ${c.dim}(${node.type})${c.reset} ${color}${stepStatus}${c.reset}${attempts > 0 ? ` ${c.dim}[${attempts} attempts]${c.reset}` : ""}`
      );

      if (step?.lastError) {
        console.log(`${prefix}  ${c.red}└ ${step.lastError}${c.reset}`);
      }

      if (node.type === "Sequence" && node.children) {
        for (const child of node.children) {
          printNode(child, indent + 1);
        }
      }
    }

    printNode(definition);

    if (Object.keys(instance.blackboard).length > 0) {
      console.log();
      console.log(`${c.bold}Blackboard${c.reset}`);
      console.log();
      console.log("  " + JSON.stringify(instance.blackboard, null, 2).split("\n").join("\n  "));
    }
    console.log();
  });

const workflows = program
  .command("workflows")
  .alias("wf")
  .description("Manage workflow definitions");

workflows
  .command("list")
  .alias("ls")
  .description("List all deployed workflows")
  .option("-j, --json", "Output raw JSON")
  .action(async (options: { json?: boolean }) => {
    const response = await apiRequest("/api/workflows");

    if (response.status === 404) {
      console.log(`${c.dim}No workflows found.${c.reset}`);
      return;
    }

    if (!response.ok) {
      throw new Error(`Failed to list workflows: ${response.status}`);
    }

    const data = (await response.json()) as {
      workflows: Array<{
        id: string;
        name: string;
        createdAt: string;
        updatedAt: string;
      }>;
    };

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (data.workflows.length === 0) {
      console.log(`${c.dim}No workflows found.${c.reset}`);
      return;
    }

    console.log();
    console.log(`${c.bold}Workflows${c.reset}`);
    console.log();

    for (const w of data.workflows) {
      console.log(`  ${c.green}●${c.reset} ${c.bold}${w.name}${c.reset}`);
      console.log(`    ${c.dim}ID: ${w.id}${c.reset}`);
      console.log(`    ${c.dim}Created: ${formatDate(w.createdAt)}${c.reset}`);
    }
    console.log();
  });

workflows
  .command("inspect")
  .description("Show details of a workflow definition")
  .argument("<name>", "Workflow name")
  .option("-j, --json", "Output raw JSON")
  .action(async (name: string, options: { json?: boolean }) => {
    const response = await apiRequest(`/api/workflows/${name}`);

    if (!response.ok) {
      throw new Error(`Workflow '${name}' not found`);
    }

    const data = (await response.json()) as {
      id: string;
      name: string;
      definition: WorkflowNode;
      createdAt: string;
      updatedAt: string;
    };

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log();
    console.log(`${c.bold}Workflow${c.reset} ${data.name}`);
    console.log();
    console.log(`  ID:      ${data.id}`);
    console.log(`  Created: ${formatDate(data.createdAt)}`);
    console.log(`  Updated: ${formatDate(data.updatedAt)}`);
    console.log();
    console.log(`${c.bold}Definition${c.reset}`);
    console.log();
    console.log("  " + JSON.stringify(data.definition, null, 2).split("\n").join("\n  "));
    console.log();
  });

workflows
  .command("delete")
  .alias("rm")
  .description("Delete a workflow definition")
  .argument("<name>", "Workflow name to delete")
  .option("-f, --force", "Skip confirmation")
  .action(async (name: string, options: { force?: boolean }) => {
    if (!options.force) {
      process.stdout.write(`Delete workflow '${name}'? [y/N] `);
      const response = await new Promise<string>((resolve) => {
        process.stdin.once("data", (data) => resolve(data.toString().trim()));
      });
      if (response.toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }
    }

    const response = await apiRequest(`/api/workflows/${name}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error(`Failed to delete workflow: ${response.status}`);
    }

    console.log(`${c.green}✓${c.reset} Workflow '${name}' deleted.`);
  });

const instances = program
  .command("instances")
  .alias("i")
  .description("Manage workflow instances");

instances
  .command("list")
  .alias("ls")
  .description("List workflow instances")
  .option("-s, --status <status>", "Filter by status (runnable, completed, failed)")
  .option("-w, --workflow <name>", "Filter by workflow name")
  .option("-j, --json", "Output raw JSON")
  .action(async (options: { status?: string; workflow?: string; json?: boolean }) => {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.workflow) params.set("workflow", options.workflow);

    const url = `/api/instances${params.toString() ? `?${params}` : ""}`;
    const response = await apiRequest(url);

    if (!response.ok) {
      throw new Error(`Failed to list instances: ${response.status}`);
    }

    const data = (await response.json()) as {
      stats: { total: number; runnable: number; completed: number; failed: number };
      instances: Array<{
        id: string;
        workflow: string;
        status: string;
        nextRunAt: string | null;
        leaseOwner: string | null;
        createdAt: string;
      }>;
    };

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log();
    console.log(
      `${c.bold}Stats${c.reset}  ${data.stats.total} total │ ${c.yellow}${data.stats.runnable} runnable${c.reset} │ ${c.green}${data.stats.completed} completed${c.reset} │ ${c.red}${data.stats.failed} failed${c.reset}`
    );
    console.log();

    if (data.instances.length === 0) {
      console.log(`${c.dim}No instances found.${c.reset}`);
      return;
    }

    console.log(
      `  ${"ID".padEnd(36)}  ${"WORKFLOW".padEnd(14)}  ${"STATUS".padEnd(10)}  ${"NEXT RUN".padEnd(18)}  CREATED`
    );
    console.log(`  ${c.dim}${"─".repeat(36)}  ${"─".repeat(14)}  ${"─".repeat(10)}  ${"─".repeat(18)}  ${"─".repeat(18)}${c.reset}`);

    for (const i of data.instances) {
      const color = statusColor(i.status);
      const nextRun = i.nextRunAt ? formatDate(i.nextRunAt) : "-";
      console.log(
        `  ${truncate(i.id, 36).padEnd(36)}  ${truncate(i.workflow, 14).padEnd(14)}  ${color}${i.status.padEnd(10)}${c.reset}  ${nextRun.padEnd(18)}  ${formatDate(i.createdAt)}`
      );
    }
    console.log();
  });

instances
  .command("delete")
  .alias("rm")
  .description("Delete a workflow instance")
  .argument("<id>", "Instance ID to delete")
  .option("-f, --force", "Skip confirmation")
  .action(async (id: string, options: { force?: boolean }) => {
    if (!options.force) {
      process.stdout.write(`Delete instance '${truncate(id, 20)}'? [y/N] `);
      const response = await new Promise<string>((resolve) => {
        process.stdin.once("data", (data) => resolve(data.toString().trim()));
      });
      if (response.toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }
    }

    const response = await apiRequest(`/api/instances/${id}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error(`Failed to delete instance: ${response.status}`);
    }

    console.log(`${c.green}✓${c.reset} Instance deleted.`);
  });

instances
  .command("reset")
  .description("Reset a failed/stuck instance back to runnable state")
  .argument("<id>", "Instance ID to reset")
  .action(async (id: string) => {
    const response = await apiRequest(`/api/instances/${id}/reset`, {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`Failed to reset instance: ${response.status}`);
    }

    console.log(`${c.green}✓${c.reset} Instance reset to runnable state.`);
  });

program
  .command("ps")
  .description("List running instances (shorthand for 'instances list --status runnable')")
  .option("-j, --json", "Output raw JSON")
  .action(async (options: { json?: boolean }) => {
    await instances.commands
      .find((c) => c.name() === "list")!
      .parseAsync(["list", "--status", "runnable", ...(options.json ? ["--json"] : [])], { from: "user" });
  });

program.parse();
