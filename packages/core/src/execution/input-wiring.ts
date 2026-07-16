// Input wiring resolution for @workflow/core

import type { StepNode } from "../types/graph.js";
import type { StepResultMap } from "../types/input-wiring.js";
import { InputWiringError } from "../errors.js";

/**
 * Resolves input wiring for a step node by invoking its inputMapper
 * against the accumulated step results.
 *
 * @param node - The step node whose input mapper should be resolved
 * @param stepResults - Map of completed step names to their result values
 * @returns The mapped input value, or undefined if no inputMapper is configured
 * @throws InputWiringError if the mapper fails (e.g., references a missing step result)
 */
export function resolveInputWiring(
  node: StepNode,
  stepResults: Map<string, unknown>
): unknown | undefined {
  if (node.inputMapper === undefined) {
    return undefined;
  }

  // Build a proxy over the step results that throws InputWiringError
  // when accessing a step name that doesn't have a result
  const resultsObject: StepResultMap = Object.fromEntries(stepResults);

  const resultsProxy = new Proxy(resultsObject, {
    get(target, prop, receiver) {
      // Allow symbol access and standard object methods to pass through
      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }

      if (!Object.prototype.hasOwnProperty.call(target, prop)) {
        throw new InputWiringError(
          node.name,
          prop,
          `referenced step "${prop}" has no result`
        );
      }

      return target[prop];
    },
  });

  try {
    return node.inputMapper(resultsProxy);
  } catch (error) {
    // If the error is already an InputWiringError, rethrow it
    if (error instanceof InputWiringError) {
      throw error;
    }

    // Wrap other errors in InputWiringError
    const message = error instanceof Error ? error.message : String(error);
    throw new InputWiringError(node.name, null, message);
  }
}
