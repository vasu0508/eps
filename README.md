# EPS — Enterprise Pipeline SDK

A monorepo for building resilient, observable pipeline orchestration tools in TypeScript.

[![npm version](https://img.shields.io/npm/v/@workflow-eps/core)](https://www.npmjs.com/package/@workflow-eps/core)

## Packages

| Package | Description | Path |
|---------|-------------|------|
| `@workflow-eps/core` | Zero-dependency pipeline orchestration library | [`packages/core`](./packages/core) |

## Quick Start

```bash
npm install @workflow-eps/core
```

```typescript
import { createPipeline } from "@workflow-eps/core";

const result = await createPipeline("my-pipeline")
  .step("greet", async () => "Hello, World!")
  .execute();

console.log(result.getValue("greet")); // "Hello, World!"
```

## Key Features

- Fluent builder API
- DAG-based parallel execution
- Retry, timeout, circuit breaker
- Branch routing, fan-out, polling
- Structured observability
- Full TypeScript support
- Zero runtime dependencies
- 635+ property-based tests

## Development

```bash
cd packages/core
npm ci
npm test
npm run build
```

## CI/CD

The repo uses GitHub Actions for CI, automatic releases on pushes to main, and preview publishes for pull requests.

## License

MIT

## Links

- npm: https://www.npmjs.com/package/@workflow-eps/core
- Detailed docs: [packages/core/README.md](./packages/core/README.md)
