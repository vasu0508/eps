# @workflow/core

Zero-dependency TypeScript pipeline orchestration library with DAG-based scheduling, resilience policies, and structured observability.

<!-- Badges placeholder -->
<!-- [![npm version](https://img.shields.io/npm/v/@workflow/core)](https://www.npmjs.com/package/@workflow/core) -->
<!-- [![CI](https://github.com/your-org/workflow-core/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/workflow-core/actions) -->
<!-- [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) -->

## Features

- **Fluent builder API** for declarative pipeline construction
- **DAG-based step scheduling** with automatic parallelization
- **Retry policies** with fixed, exponential, and linear backoff
- **Timeout enforcement** per step
- **Circuit breaker** pattern (closed/open/half-open states)
- **Fallback chains** (up to 5 per step)
- **Conditional execution** via `.onlyIf()`
- **Optional steps** with default values
- **Branch evaluation** for mutually exclusive routing
- **ForEach fan-out** with concurrency control
- **RepeatUntil polling** with termination guarantees
- **Sub-pipeline composition**
- **Input wiring** between steps
- **Error transformation** via `.mapError()`
- **Structured observability** (Logger, Metrics, Tracer interfaces)
- **Pipeline result** with `.getValue()`, `.getError()`, `.toJSON()`
- **Full TypeScript type safety**
- **ESM + CJS dual output**
- **Property-based tested** with fast-check (635+ tests)

## Installation

```bash
npm install @workflow/core
```

```bash
yarn add @workflow/core
```

```bash
pnpm add @workflow/core
```

Requires Node.js >= 18.0.0.

## Quick Start

```typescript
import { createPipeline } from "@workflow/core";

const result = await createPipeline("greeting")
  .step("FetchUser", async (ctx) => {
    return { name: "Alice", id: ctx.userContext.userId };
  })
  .step("BuildGreeting", async (ctx) => {
    const user = ctx.stepResults.get("FetchUser") as { name: string };
    return `Hello, ${user.name}!`;
  })
    .dependsOn("FetchUser")
  .step("Send", async (ctx) => {
    const message = ctx.stepResults.get("BuildGreeting") as string;
    console.log(message);
    return { sent: true };
  })
    .dependsOn("BuildGreeting")
  .execute();

console.log(result.success); // true
console.log(result.getValue<string>("BuildGreeting")); // "Hello, Alice!"
```

## API Reference

### Pipeline Builder

#### `createPipeline<TContext>(name?: string)`

Creates a new pipeline builder instance.

```typescript
import { createPipeline } from "@workflow/core";

const pipeline = createPipeline<{ userId: string }>("order-flow");
```

#### `.withContext(context: TContext)`

Injects user context available to all step handlers via `ctx.userContext`.

```typescript
createPipeline<{ apiKey: string }>("my-pipeline")
  .withContext({ apiKey: "sk-..." });
```

#### `.step(name, handler)`

Declares a step with a unique name and an async handler.

```typescript
.step("FetchData", async (ctx) => {
  const response = await fetch(`/api?key=${ctx.userContext.apiKey}`);
  return response.json();
})
```

The handler receives an `ExecutionContext<TContext>` with:
- `pipelineId` / `correlationId` - execution identifiers
- `stepResults` - read-only map of completed step results
- `userContext` - your injected context
- `abortSignal` - signal for cancellation
- `logger` / `metrics` - observability handles

#### `.execute(options?)`

Validates and runs the pipeline. Returns a `PipelineResult`.

```typescript
const result = await pipeline.execute({
  correlationId: "order-123",
  timeout: 30_000,
  maxConcurrency: 4,
  signal: abortController.signal,
});
```

#### `.validate()`

Validates the pipeline graph without executing. Throws on empty pipelines, cycles, or invalid dependencies.

```typescript
pipeline.validate(); // throws EmptyPipelineError, ValidationError, etc.
```

---

### Step Policies

Policies are chained off a `.step()` call:

#### `.retry(count, options?)`

Retry on failure with configurable backoff.

```typescript
.step("CallAPI", handler)
  .retry(3, { backoff: "exponential", baseDelay: 1000, maxDelay: 10_000 })
```

Options:
- `backoff` - `"fixed"` | `"exponential"` | `"linear"` (default: `"fixed"`)
- `baseDelay` - base delay in ms (default: varies by strategy)
- `maxDelay` - cap on delay in ms
- `retryOn` - predicate to filter retryable errors

#### `.timeout(ms)`

Enforces a time limit on step execution.

```typescript
.step("SlowOp", handler)
  .timeout(5000) // 5 second timeout
```

#### `.circuitBreaker(serviceName, options)`

Applies the circuit breaker pattern. Shared state across steps with the same `serviceName`.

```typescript
.step("ExternalCall", handler)
  .circuitBreaker("payment-service", {
    failureThreshold: 5,
    resetTimeout: 30_000,
    halfOpenMax: 2,
    onStateChange: (from, to) => console.log(`${from} -> ${to}`),
  })
```

#### `.fallback(handler)`

Registers a fallback handler (up to 5 per step). Tried in order if the primary handler fails.

```typescript
.step("GetPrice", primaryHandler)
  .fallback(async (ctx) => getCachedPrice())
  .fallback(async (ctx) => getDefaultPrice())
```

#### `.onlyIf(predicate)`

Conditionally executes the step. Skipped steps produce `{ status: "skipped" }`.

```typescript
.step("SendEmail", handler)
  .onlyIf((ctx) => ctx.emailEnabled)
```

#### `.optional(defaultValue?)`

Marks a step as optional. Failed optional steps don't fail the pipeline.

```typescript
.step("Analytics", handler)
  .optional({ tracked: false })
```

#### `.input(mapper)`

Wires inputs from prior step results into a structured input object.

```typescript
.step("Combine", async (ctx) => {
  // ctx receives mapped input
  return processData(ctx);
})
  .input((results) => ({
    user: results["FetchUser"],
    orders: results["FetchOrders"],
  }))
  .dependsOn("FetchUser", "FetchOrders")
```

#### `.mapError(transformer)`

Transforms errors before they propagate. Multiple calls chain in declaration order.

```typescript
.step("Parse", handler)
  .mapError((err) => new AppError("PARSE_FAILED", err.message, { cause: err }))
```

#### `.dependsOn(...steps)`

Declares dependencies. The step only runs after all dependencies complete.

```typescript
.step("Ship", handler)
  .dependsOn("Payment", "Inventory")
```

---

### Branching

Mutually exclusive routing based on a discriminator value.

```typescript
createPipeline<{ orderType: string }>("route-order")
  .withContext({ orderType: "digital" })
  .branch("Route", (ctx) => ctx.userContext.orderType)
    .when("physical", async (ctx) => {
      return { warehouse: "NYC", shipBy: "ground" };
    })
    .when("digital", async (ctx) => {
      return { deliveryMethod: "email", instant: true };
    })
    .otherwise(async (ctx) => {
      return { error: "unknown order type" };
    })
  .step("Confirm", confirmHandler)
    .dependsOn("Route")
  .execute();
```

- `.branch(name, discriminator)` - start a branch with a discriminator function
- `.when(value, handler)` - register a handler for a specific discriminator value
- `.otherwise(handler)` - default handler when no `.when()` matches

---

### ForEach

Fan-out execution over a collection with concurrency control.

```typescript
createPipeline("batch-process")
  .step("FetchItems", async () => [1, 2, 3, 4, 5])
  .forEach("ProcessItem", async (ctx) => {
    // Handler is called once per element
    return { processed: true };
  })
    .from((ctx) => ctx.stepResults.get("FetchItems") as number[])
    .withConcurrency(3)
    .dependsOn("FetchItems")
  .step("Summary", async (ctx) => {
    return { total: 5 };
  })
    .dependsOn("ProcessItem")
  .execute();
```

- `.forEach(name, handler)` - declare a fan-out step
- `.from(mapper)` - extracts the collection to iterate over
- `.withConcurrency(n)` - limits parallel element execution

---

### RepeatUntil

Polling with termination guarantees.

```typescript
createPipeline("poll-status")
  .step("StartJob", async () => ({ jobId: "abc-123" }))
  .repeatUntil("WaitForCompletion", async (ctx) => {
    const jobId = (ctx.stepResults.get("StartJob") as { jobId: string }).jobId;
    const status = await checkJobStatus(jobId);
    return status;
  })
    .until((result) => (result as { done: boolean }).done === true)
    .maxIterations(20)
    .delay(2000)
    .dependsOn("StartJob")
  .execute();
```

- `.repeatUntil(name, handler)` - declare a polling step
- `.until(predicate)` - stop when predicate returns `true`
- `.maxIterations(n)` - hard cap on iterations (throws `MaxIterationsExhaustedError` if exceeded)
- `.delay(ms)` - wait between iterations (not applied after the final one)

---

### Pipeline Result

The `PipelineResult<TContext>` returned from `.execute()`:

```typescript
const result = await pipeline.execute();

// Status
result.success;        // boolean
result.duration;       // total ms
result.executionId;    // UUID
result.correlationId;  // UUID or custom

// Access step values
const user = result.getValue<User>("FetchUser");

// Access step errors
const err = result.getError("FailedStep");

// Inspect all steps
result.steps; // ReadonlyMap<string, StepResult>

// Execution report with detailed timing and retry history
result.report;
result.report.status; // "success" | "partial" | "failed"
result.report.steps;  // StepReport[] with retryHistory, fallbackHistory, etc.

// Serialize for logging/storage
const json = result.toJSON();
```

Step result statuses:
- `"success"` - handler completed
- `"fallback"` - primary failed, fallback succeeded
- `"default"` - optional step failed, default value used
- `"skipped"` - condition not met or pipeline aborted
- `"failed"` - unrecoverable error

---

### Observability

#### `.withLogger(logger)`

Accepts any object implementing the `Logger` interface:

```typescript
import { createPipeline, ConsoleLogger } from "@workflow/core";

createPipeline("observed")
  .withLogger(new ConsoleLogger("my-app"))
  .step("Work", handler)
  .execute();
```

The `Logger` interface:

```typescript
interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
```

#### `.withMetrics(collector)`

```typescript
import { createPipeline, InMemoryMetrics } from "@workflow/core";

const metrics = new InMemoryMetrics();

await createPipeline("metered")
  .withMetrics(metrics)
  .step("Work", handler)
  .execute();

console.log(metrics.getMetrics()); // MetricEntry[]
```

The `MetricsCollector` interface:

```typescript
interface MetricsCollector {
  increment(metric: string, tags?: Record<string, string>): void;
  gauge(metric: string, value: number, tags?: Record<string, string>): void;
  histogram(metric: string, value: number, tags?: Record<string, string>): void;
  timing(metric: string, duration: number, tags?: Record<string, string>): void;
}
```

#### `.withTracer(tracer)`

Distributed tracing integration via the `Tracer` interface.

---

## Advanced Examples

### Retry with Exponential Backoff

```typescript
const result = await createPipeline("resilient-fetch")
  .step("CallAPI", async (ctx) => {
    const res = await fetch("https://api.example.com/data");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
    .retry(4, {
      backoff: "exponential",
      baseDelay: 500,
      maxDelay: 8000,
      retryOn: (err) => err.message.includes("5"),  // retry on 5xx
    })
    .timeout(10_000)
  .execute();
```

### Circuit Breaker

```typescript
const result = await createPipeline("protected")
  .step("PaymentGateway", async (ctx) => {
    return await chargeCard(ctx.userContext.card);
  })
    .circuitBreaker("payment-svc", {
      failureThreshold: 3,
      resetTimeout: 60_000,
      halfOpenMax: 1,
      onStateChange: (from, to) => {
        console.log(`Circuit: ${from} -> ${to}`);
      },
    })
    .fallback(async () => ({ status: "queued", message: "Will retry later" }))
  .execute();
```

### Branch Routing

```typescript
interface OrderCtx {
  tier: "free" | "premium" | "enterprise";
}

const result = await createPipeline<OrderCtx>("tiered-flow")
  .withContext({ tier: "premium" })
  .branch("SelectPlan", (ctx) => ctx.userContext.tier)
    .when("free", async () => ({ features: ["basic"], support: "community" }))
    .when("premium", async () => ({ features: ["basic", "advanced"], support: "email" }))
    .when("enterprise", async () => ({ features: ["all"], support: "dedicated" }))
    .otherwise(async () => ({ features: ["basic"], support: "none" }))
  .step("Provision", async (ctx) => {
    const plan = ctx.stepResults.get("SelectPlan");
    return { provisioned: true, plan };
  })
    .dependsOn("SelectPlan")
  .execute();
```

### Fan-Out Processing

```typescript
const result = await createPipeline("image-processing")
  .step("ListImages", async () => {
    return ["img1.png", "img2.png", "img3.png", "img4.png"];
  })
  .forEach("Resize", async (ctx) => {
    // Each invocation processes one image
    return { resized: true, timestamp: Date.now() };
  })
    .from((ctx) => ctx.stepResults.get("ListImages") as string[])
    .withConcurrency(2)
    .dependsOn("ListImages")
  .step("GenerateManifest", async (ctx) => {
    return { imageCount: 4, complete: true };
  })
    .dependsOn("Resize")
  .execute();
```

### Polling Until Done

```typescript
const result = await createPipeline("export-job")
  .step("StartExport", async () => {
    const job = await startExportJob();
    return { jobId: job.id };
  })
  .repeatUntil("PollStatus", async (ctx) => {
    const { jobId } = ctx.stepResults.get("StartExport") as { jobId: string };
    return await getJobStatus(jobId);
  })
    .until((status) => (status as { state: string }).state === "complete")
    .maxIterations(30)
    .delay(5000)
    .timeout(10_000)
    .dependsOn("StartExport")
  .step("Download", async (ctx) => {
    const status = ctx.stepResults.get("PollStatus") as { url: string };
    return await downloadFile(status.url);
  })
    .dependsOn("PollStatus")
  .execute();
```

### Error Transformation

```typescript
import { createPipeline } from "@workflow/core";

class AppError extends Error {
  constructor(public code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppError";
  }
}

const result = await createPipeline("transform-errors")
  .step("ParseInput", async () => {
    return JSON.parse(rawInput);
  })
    .mapError((err) => new AppError("PARSE_ERROR", `Invalid input: ${err.message}`, { cause: err }))
  .step("Validate", async (ctx) => {
    const data = ctx.stepResults.get("ParseInput");
    if (!isValid(data)) throw new Error("Validation failed");
    return data;
  })
    .dependsOn("ParseInput")
    .mapError((err) => new AppError("VALIDATION_ERROR", err.message, { cause: err }))
  .execute();

// Errors are transformed before reaching the result
const error = result.getError("ParseInput");
if (error instanceof AppError) {
  console.log(error.code); // "PARSE_ERROR"
}
```

### Conditional Execution

```typescript
interface FeatureFlags {
  analyticsEnabled: boolean;
  notificationsEnabled: boolean;
}

const result = await createPipeline<FeatureFlags>("conditional")
  .withContext({ analyticsEnabled: true, notificationsEnabled: false })
  .step("CoreWork", async () => ({ data: "processed" }))
  .step("TrackAnalytics", async (ctx) => {
    await sendAnalytics(ctx.stepResults.get("CoreWork"));
    return { tracked: true };
  })
    .dependsOn("CoreWork")
    .onlyIf((ctx) => ctx.analyticsEnabled)
  .step("SendNotification", async (ctx) => {
    await notify(ctx.stepResults.get("CoreWork"));
    return { notified: true };
  })
    .dependsOn("CoreWork")
    .onlyIf((ctx) => ctx.notificationsEnabled)
    .optional({ notified: false })
  .execute();
```

### Full Real-World Pipeline

```typescript
import { createPipeline, ConsoleLogger, InMemoryMetrics } from "@workflow/core";

interface OrderContext {
  customerId: string;
  orderId: string;
}

const logger = new ConsoleLogger("order-pipeline");
const metrics = new InMemoryMetrics();

const result = await createPipeline<OrderContext>("process-order")
  .withContext({ customerId: "cust-42", orderId: "ord-789" })
  .withLogger(logger)
  .withMetrics(metrics)

  // Fetch customer and inventory in parallel (no shared dependencies)
  .step("FetchCustomer", async (ctx) => {
    return await getCustomer(ctx.userContext.customerId);
  })
    .retry(2, { backoff: "exponential", baseDelay: 500 })
    .timeout(5000)

  .step("CheckInventory", async (ctx) => {
    return await checkStock(ctx.userContext.orderId);
  })
    .retry(2, { backoff: "fixed", baseDelay: 1000 })
    .timeout(3000)

  // Route based on stock status
  .branch("FulfillmentRoute", (ctx) => {
    const stock = ctx.stepResults.get("CheckInventory") as { inStock: boolean };
    return stock.inStock ? "immediate" : "backorder";
  })
    .when("immediate", async (ctx) => {
      return { method: "ship-now", eta: "2 days" };
    })
    .when("backorder", async (ctx) => {
      return { method: "backorder", eta: "2 weeks" };
    })
    .dependsOn("CheckInventory")

  // Charge payment with circuit breaker
  .step("ChargePayment", async (ctx) => {
    const customer = ctx.stepResults.get("FetchCustomer") as { paymentMethod: string };
    return await processPayment(customer.paymentMethod);
  })
    .dependsOn("FetchCustomer", "FulfillmentRoute")
    .circuitBreaker("payment-gateway", { failureThreshold: 5, resetTimeout: 30_000 })
    .retry(3, { backoff: "exponential", baseDelay: 1000 })
    .timeout(15_000)
    .fallback(async () => ({ status: "pending", retryLater: true }))

  // Optional analytics
  .step("RecordAnalytics", async (ctx) => {
    return await trackOrder(ctx.userContext.orderId);
  })
    .dependsOn("ChargePayment")
    .optional({ recorded: false })
    .timeout(2000)

  // Send confirmation
  .step("SendConfirmation", async (ctx) => {
    const fulfillment = ctx.stepResults.get("FulfillmentRoute");
    return await sendEmail(ctx.userContext.customerId, fulfillment);
  })
    .dependsOn("ChargePayment", "FulfillmentRoute")
    .retry(2)
    .mapError((err) => new Error(`Email failed: ${err.message}`))

  .execute({ correlationId: "order-ord-789", maxConcurrency: 4 });

// Inspect results
console.log(`Order processed: ${result.success}`);
console.log(`Duration: ${result.duration}ms`);
console.log(`Payment: ${JSON.stringify(result.getValue("ChargePayment"))}`);
console.log(`Report: ${JSON.stringify(result.report.toJSON(), null, 2)}`);
```

## Architecture

The library is organized into distinct layers:

```
┌─────────────────────────────────────────┐
│           Pipeline Builder              │  Fluent API, validation
├─────────────────────────────────────────┤
│          Execution Graph                │  DAG construction, topological sort
├─────────────────────────────────────────┤
│          Step Scheduler                 │  Layer-by-layer parallel execution
├──────────┬──────────┬───────────────────┤
│  Step    │ ForEach  │  RepeatUntil      │  Executors
│ Executor │ Executor │  Executor         │
├──────────┴──────────┴───────────────────┤
│             Policies                    │  Retry, Timeout, Circuit Breaker
├─────────────────────────────────────────┤
│           Observability                 │  Logger, Metrics, Tracer
└─────────────────────────────────────────┘
```

**How it works:**

1. **Build phase** - The fluent API accumulates `StepDefinition` objects with handlers, dependencies, and policies.
2. **Validation** - The execution graph builder constructs a DAG, validates dependencies, and detects cycles.
3. **Scheduling** - The step scheduler computes execution layers (sets of steps with no unresolved deps) and runs each layer in parallel respecting `maxConcurrency`.
4. **Execution** - Each step is wrapped with its configured policies (timeout → retry → circuit breaker → fallback → error transform) and run. Results are made available to downstream steps via `stepResults`.
5. **Reporting** - An `ExecutionReport` captures timing, retry history, fallback attempts, and step statuses for post-execution analysis.

Steps without dependencies run in parallel automatically. The scheduler resolves the graph layer by layer, enabling maximum concurrency while respecting declared ordering constraints.

## Testing

The library is thoroughly tested with **635+ tests** including both unit tests and property-based tests using [fast-check](https://github.com/dubzzz/fast-check).

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Type checking
npm run typecheck
```

Property-based tests cover:
- Pipeline builder invariants
- Step scheduling correctness
- Retry policy delay calculations
- Circuit breaker state transitions
- Branch evaluation
- ForEach concurrency guarantees
- Input wiring resolution
- Error transformation chains

## License

MIT
