// Step scheduler with event emission for @workflow/core
// Orchestrates step execution based on graph topology, managing parallelism,
// conditional execution, cancellation, and dependency resolution.

import type { ExecutionContext, StepResult } from "../types.js";
import type { ExecutionGraph, StepNode } from "../types/graph.js";
import { executeStep } from "./step-executor.js";

/**
 * Events emitted by the scheduler during pipeline execution.
 */
export type SchedulerEvent =
  | { type: "step:start"; step: string; timestamp: number }
  | { type: "step:complete"; step: string; result: unknown; duration: number }
  | { type: "step:failed"; step: string; error: Error; duration: number }
  | { type: "step:skipped"; step: string; reason: string }
  | { type: "step:cancelled"; step: string }
  | { type: "pipeline:complete"; success: boolean }
  | { type: "pipeline:aborted"; reason: string };

/**
 * Options for running the scheduler.
 */
export interface SchedulerOptions {
  graph: ExecutionGraph;
  context: ExecutionContext<unknown>;
  maxConcurrency?: number;
  signal?: AbortSignal;
  onEvent?: (event: SchedulerEvent) => void;
}

/**
 * Result of scheduler execution.
 */
export interface SchedulerResult {
  success: boolean;
  stepResults: Map<string, StepResult<unknown>>;
  events: SchedulerEvent[];
}

/**
 * Runs the step scheduler: determines ready steps from the execution graph,
 * launches them respecting concurrency limits, evaluates conditional predicates,
 * handles failures (required vs optional), and propagates cancellation.
 *
 * Algorithm:
 * 1. Start with all steps in "pending" state
 * 2. Loop until no more steps can be scheduled:
 *    a. Get ready steps (all dependencies satisfied)
 *    b. For each ready step:
 *       - If a required dependency failed → skip with reason "dependency failed"
 *       - Evaluate .onlyIf() predicate → skip if false
 *       - Otherwise → dispatch to executeStep
 *    c. Respect maxConcurrency
 *    d. On step complete: handle success/failure/optional-default
 *    e. On abort signal → cancel all, skip remaining
 * 3. Mark unreachable steps as skipped
 * 4. Emit pipeline:complete event
 * 5. Return SchedulerResult
 */
export async function runScheduler(options: SchedulerOptions): Promise<SchedulerResult> {
  const { graph, context, maxConcurrency = Infinity, signal, onEvent } = options;

  const events: SchedulerEvent[] = [];
  const stepResults = new Map<string, StepResult<unknown>>();

  // State tracking sets
  // "done" means the step won't be re-evaluated (completed, skipped, or failed)
  const done = new Set<string>();
  const failed = new Set<string>(); // Steps that failed and are required
  const running = new Set<string>();
  const pending = new Set<string>();

  // Track running step promises for awaiting
  const runningPromises = new Map<string, Promise<void>>();

  // Internal abort controller for propagating required-step failure or external cancellation
  const internalAbortController = new AbortController();
  let aborted = false;
  let abortReason = "";

  // Initialize all steps as pending
  for (const name of graph.nodes.keys()) {
    pending.add(name);
  }

  function emit(event: SchedulerEvent): void {
    events.push(event);
    onEvent?.(event);
  }

  // Listen to external abort signal
  if (signal) {
    if (signal.aborted) {
      // Already aborted — skip everything immediately
      aborted = true;
      abortReason = signal.reason ?? "Pipeline aborted";
      internalAbortController.abort(abortReason);
      for (const name of pending) {
        const result: StepResult<unknown> = { status: "skipped", reason: "pipeline aborted" };
        stepResults.set(name, result);
        done.add(name);
        emit({ type: "step:cancelled", step: name });
      }
      pending.clear();
      emit({ type: "pipeline:aborted", reason: abortReason });
      emit({ type: "pipeline:complete", success: false });
      return { success: false, stepResults, events };
    }

    signal.addEventListener("abort", () => {
      if (!aborted) {
        aborted = true;
        abortReason = signal.reason ?? "Pipeline aborted";
        internalAbortController.abort(abortReason);
      }
    }, { once: true });
  }

  /**
   * Returns true if a step has a required dependency that failed.
   */
  function hasFailedRequiredDependency(node: StepNode): boolean {
    for (const dep of node.dependencies) {
      if (failed.has(dep)) {
        return true;
      }
      // Transitively: if dep was skipped due to a dependency failure
      const depResult = stepResults.get(dep);
      if (depResult && depResult.status === "skipped" && depResult.reason === "dependency failed") {
        return true;
      }
    }
    return false;
  }

  /**
   * Creates a step-specific execution context using the internal abort controller.
   */
  function createStepContext(): ExecutionContext<unknown> {
    return {
      ...context,
      abortSignal: internalAbortController.signal,
      stepResults: new Map(
        [...stepResults.entries()]
          .filter(([, r]) => r.status === "success" || r.status === "fallback" || r.status === "default")
          .map(([name, r]) => {
            if (r.status === "success" || r.status === "fallback" || r.status === "default") {
              return [name, r.value];
            }
            return [name, undefined];
          })
      ),
    };
  }

  /**
   * Builds the step results map for input wiring (step name → value).
   */
  function buildStepResultsMap(): Map<string, unknown> {
    const map = new Map<string, unknown>();
    for (const [name, result] of stepResults.entries()) {
      if (result.status === "success" || result.status === "fallback" || result.status === "default") {
        map.set(name, result.value);
      }
    }
    return map;
  }

  /**
   * Handles a completed step result.
   */
  function handleStepResult(node: StepNode, result: StepResult<unknown>, duration: number): void {
    if (result.status === "failed") {
      if (node.isRequired) {
        stepResults.set(node.name, result);
        failed.add(node.name);
        done.add(node.name);
        emit({ type: "step:failed", step: node.name, error: result.error, duration });

        if (!aborted) {
          aborted = true;
          abortReason = `Required step failed: ${node.name}`;
          internalAbortController.abort(abortReason);
        }
      } else {
        // Optional step failure
        const defaultValue = node.policies.defaultValue;
        if (defaultValue !== undefined) {
          const defaultResult: StepResult<unknown> = { status: "default", value: defaultValue };
          stepResults.set(node.name, defaultResult);
          done.add(node.name);
          emit({ type: "step:complete", step: node.name, result: defaultValue, duration });
        } else {
          stepResults.set(node.name, result);
          done.add(node.name);
          emit({ type: "step:failed", step: node.name, error: result.error, duration });
        }
      }
    } else {
      stepResults.set(node.name, result);
      done.add(node.name);

      if (result.status === "success" || result.status === "fallback" || result.status === "default") {
        emit({ type: "step:complete", step: node.name, result: result.value, duration });
      } else if (result.status === "skipped") {
        emit({ type: "step:skipped", step: node.name, reason: result.reason });
      }
    }
  }

  /**
   * Executes a single step and handles its result.
   */
  async function runStep(node: StepNode): Promise<void> {
    const startTime = Date.now();
    emit({ type: "step:start", step: node.name, timestamp: startTime });

    const stepContext = createStepContext();
    const stepResultsMap = buildStepResultsMap();

    try {
      const result = await executeStep(node, stepContext, stepResultsMap);
      const duration = Date.now() - startTime;
      handleStepResult(node, result, duration);
    } catch (err) {
      const duration = Date.now() - startTime;
      const error = err instanceof Error ? err : new Error(String(err));
      const failedResult: StepResult<unknown> = {
        status: "failed",
        error,
        duration,
        attempts: 0,
      };
      handleStepResult(node, failedResult, duration);
    } finally {
      running.delete(node.name);
      runningPromises.delete(node.name);
    }
  }

  // Main scheduling loop
  while (pending.size > 0 || running.size > 0) {
    // Check for abort — skip all remaining pending steps
    if (aborted && pending.size > 0) {
      // Before blindly marking as "pipeline aborted", check for dependency failures
      for (const name of [...pending]) {
        pending.delete(name);
        const node = graph.nodes.get(name)!;
        const reason = hasFailedRequiredDependency(node)
          ? "dependency failed"
          : "pipeline aborted";
        const result: StepResult<unknown> = { status: "skipped", reason };
        stepResults.set(name, result);
        done.add(name);
        emit({ type: "step:cancelled", step: name });
      }
    }

    if (aborted && running.size > 0) {
      // Wait for running steps to finish (they'll observe the abort signal)
      await Promise.all([...runningPromises.values()]);
      break;
    }

    if (aborted && running.size === 0) {
      break;
    }

    // Get steps whose dependencies are all done
    const readyNodes = graph.getReadySteps(done)
      .filter(node => pending.has(node.name));

    if (readyNodes.length === 0 && running.size === 0) {
      // No more steps can be scheduled — mark remaining as unreachable
      break;
    }

    if (readyNodes.length === 0 && running.size > 0) {
      // Wait for at least one running step to complete
      await Promise.race([...runningPromises.values()]);
      continue;
    }

    // Process ready steps: evaluate conditions and dependency failure checks
    const stepsToLaunch: StepNode[] = [];
    let madeProgress = false;

    for (const node of readyNodes) {
      // Check if a required dependency failed → skip with "dependency failed"
      if (hasFailedRequiredDependency(node)) {
        pending.delete(node.name);
        const result: StepResult<unknown> = { status: "skipped", reason: "dependency failed" };
        stepResults.set(node.name, result);
        done.add(node.name);
        emit({ type: "step:skipped", step: node.name, reason: "dependency failed" });
        madeProgress = true;
        continue;
      }

      // Evaluate .onlyIf() predicate
      if (node.policies.condition) {
        try {
          const shouldRun = node.policies.condition(context.userContext);
          if (!shouldRun) {
            pending.delete(node.name);
            const result: StepResult<unknown> = { status: "skipped", reason: "condition not met" };
            stepResults.set(node.name, result);
            done.add(node.name);
            emit({ type: "step:skipped", step: node.name, reason: "condition not met" });
            madeProgress = true;
            continue;
          }
        } catch (condError) {
          // Predicate threw → mark step as failed
          pending.delete(node.name);
          const error = condError instanceof Error ? condError : new Error(String(condError));
          const failedResult: StepResult<unknown> = {
            status: "failed",
            error,
            duration: 0,
            attempts: 0,
          };
          stepResults.set(node.name, failedResult);

          if (node.isRequired) {
            failed.add(node.name);
            done.add(node.name);
            emit({ type: "step:failed", step: node.name, error, duration: 0 });

            if (!aborted) {
              aborted = true;
              abortReason = `Required step failed: ${node.name}`;
              internalAbortController.abort(abortReason);
            }
          } else {
            done.add(node.name);
            emit({ type: "step:failed", step: node.name, error, duration: 0 });
          }
          madeProgress = true;
          continue;
        }
      }

      stepsToLaunch.push(node);
    }

    // If we made progress (skipped/failed steps), re-loop to evaluate newly-ready steps
    if (madeProgress && stepsToLaunch.length === 0) {
      continue;
    }

    // Respect maxConcurrency: only launch up to available slots
    const availableSlots = Math.max(0, maxConcurrency - running.size);
    const batch = stepsToLaunch.slice(0, availableSlots);

    if (batch.length === 0 && running.size > 0) {
      // All slots occupied, wait for one to finish
      await Promise.race([...runningPromises.values()]);
      continue;
    }

    if (batch.length === 0 && running.size === 0 && !madeProgress) {
      // Nothing to launch, nothing running, no progress — we're stuck
      break;
    }

    // Launch batch of steps concurrently
    for (const node of batch) {
      pending.delete(node.name);
      running.add(node.name);
      const promise = runStep(node);
      runningPromises.set(node.name, promise);
    }

    // Wait for at least one launched step to complete
    if (runningPromises.size > 0) {
      await Promise.race([...runningPromises.values()]);
    }
  }

  // Mark any remaining pending steps as skipped (unreachable)
  for (const name of pending) {
    if (!stepResults.has(name)) {
      const result: StepResult<unknown> = { status: "skipped", reason: "unreachable" };
      stepResults.set(name, result);
      done.add(name);
      emit({ type: "step:skipped", step: name, reason: "unreachable" });
    }
  }

  // Determine overall success
  const success = !aborted && failed.size === 0;

  if (aborted) {
    emit({ type: "pipeline:aborted", reason: abortReason });
  }
  emit({ type: "pipeline:complete", success });

  return { success, stepResults, events };
}
