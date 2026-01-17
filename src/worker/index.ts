import {
  claimNextInstance,
  getWorkflowDefinitionById,
  getWorkflowSteps,
  getOrCreateStep,
  updateStepSuccess,
  updateStepFailed,
  updateInstanceBlackboard,
  updateInstanceStatus,
  releaseInstanceLease,
  getNextRunTime,
  incrementStepAttempts,
  type WorkflowInstanceRow,
  type WorkflowStepRow,
} from "../db";
import {
  findNextNode,
  isSequenceComplete,
  executeNode,
  applyPatches,
} from "../engine";
import type { WorkflowNode } from "../sdk/types";

const LEASE_MS = 30000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

function generateWorkerId(): string {
  return `worker-${process.pid}-${Date.now()}`;
}

function calculateBackoff(attempts: number): number {
  return BACKOFF_BASE_MS * Math.pow(2, attempts - 1);
}

export async function runWorkerLoop(workerId: string = generateWorkerId()) {
  console.log(`🚀 Worker ${workerId} starting...`);

  while (true) {
    try {
      const instance = await claimNextInstance(workerId, LEASE_MS);

      if (!instance) {
        const nextRun = await getNextRunTime();
        if (nextRun) {
          const waitMs = Math.min(
            Math.max(nextRun.getTime() - Date.now(), 100),
            5000
          );
          await Bun.sleep(waitMs + Math.random() * 500);
        } else {
          await Bun.sleep(1000);
        }
        continue;
      }

      console.log(`📋 Claimed instance ${instance.id}`);
      await processInstance(instance, workerId);
    } catch (error) {
      console.error("Worker loop error:", error);
      await Bun.sleep(1000);
    }
  }
}

async function processInstance(
  instance: WorkflowInstanceRow,
  workerId: string
): Promise<void> {
  try {
    const definition = await getWorkflowDefinitionById(instance.definition_id);
    if (!definition) {
      console.error(`Definition not found for instance ${instance.id}`);
      await updateInstanceStatus(instance.id, "failed");
      return;
    }

    const rootNode = definition.definition_json as WorkflowNode;
    const stepsArray = await getWorkflowSteps(instance.id);
    const steps = new Map<string, WorkflowStepRow>(
      stepsArray.map((s) => [s.node_id, s])
    );
    let blackboard = instance.blackboard as Record<string, unknown>;

    if (isSequenceComplete(rootNode, steps, blackboard)) {
      console.log(`✅ Instance ${instance.id} completed`);
      await updateInstanceStatus(instance.id, "completed");
      return;
    }

    const nextResult = findNextNode(rootNode, steps, blackboard);
    if (!nextResult) {
      console.log(`✅ Instance ${instance.id} completed (no more nodes)`);
      await updateInstanceStatus(instance.id, "completed");
      return;
    }

    const { node: nextNode, nodeId, blackboard: nodeBlackboard } = nextResult;

    console.log(`▶️  Executing node: ${nodeId} (${nextNode.type})`);

    const step = await getOrCreateStep(instance.id, nodeId);

    if (step.status === "succeeded") {
      console.log(`⏭️  Node ${nodeId} already succeeded, skipping`);
      await releaseInstanceLease(instance.id);
      return;
    }

    const attempts = await incrementStepAttempts(instance.id, nodeId);

    // Execute with the node-specific blackboard (may include loop context like __item)
    const result = await executeNode(nextNode, nodeBlackboard, instance.id, attempts);

    // Apply patches to the main blackboard (not the loop-scoped one)
    if (result.patch) {
      blackboard = applyPatches(blackboard, result.patch);
      await updateInstanceBlackboard(instance.id, blackboard);
    }

    switch (result.kind) {
      case "success":
        await updateStepSuccess(instance.id, nodeId);
        console.log(`✓ Node ${nodeId} succeeded`);

        const updatedSteps = await getWorkflowSteps(instance.id);
        const updatedStepsMap = new Map<string, WorkflowStepRow>(
          updatedSteps.map((s) => [s.node_id, s])
        );

        if (isSequenceComplete(rootNode, updatedStepsMap, blackboard)) {
          console.log(`✅ Instance ${instance.id} completed`);
          await updateInstanceStatus(instance.id, "completed");
        } else {
          await updateInstanceStatus(instance.id, "runnable", new Date());
        }
        break;

      case "wait":
        await updateStepSuccess(instance.id, nodeId);
        const nextRunAt = new Date(result.nextRunAtMs);
        console.log(`⏸️  Node ${nodeId} waiting until ${nextRunAt.toISOString()}`);
        await updateInstanceStatus(instance.id, "runnable", nextRunAt);
        break;

      case "fail":
        console.error(`✗ Node ${nodeId} failed: ${result.error}`);

        if (attempts < MAX_ATTEMPTS) {
          const backoffMs = calculateBackoff(attempts);
          const retryAt = result.retryAtMs
            ? new Date(result.retryAtMs)
            : new Date(Date.now() + backoffMs);
          console.log(`🔄 Retry ${attempts}/${MAX_ATTEMPTS} scheduled for ${retryAt.toISOString()}`);
          await updateInstanceStatus(instance.id, "runnable", retryAt);
        } else {
          console.error(`❌ Instance ${instance.id} failed after ${MAX_ATTEMPTS} attempts`);
          await updateStepFailed(instance.id, nodeId, result.error);
          await updateInstanceStatus(instance.id, "failed");
        }
        break;
    }
  } catch (error) {
    console.error(`Error processing instance ${instance.id}:`, error);
    await releaseInstanceLease(instance.id);
  }
}

if (import.meta.main) {
  runWorkerLoop();
}
