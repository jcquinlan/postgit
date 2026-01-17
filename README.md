# Postgit

A durable workflow engine powered by Postgres. Like post-it notes for your workflows — stick them, they stay.

## Prerequisites

- [Bun](https://bun.sh) runtime
- PostgreSQL database

## Quick Start

```bash
# Start Postgres (via Docker)
docker compose up -d

# Terminal 1: API Server
bun run server

# Terminal 2: Worker
bun run worker

# Terminal 3: Deploy and run a workflow
bun run pst deploy examples/demo.ts demo
bun run pst run demo --watch
```

## CLI Usage

```bash
# Deploy a workflow
bun run pst deploy <file.ts> [name]

# Run an instance
bun run pst run <workflow> [--watch]

# Check instance status
bun run pst status <instance-id>

# List workflows
bun run pst wf ls

# List instances
bun run pst i ls

# See all commands
bun run pst --help
```

Use `pst` or `postgit` interchangeably.

## Example Workflow

```typescript
import { Sequence, HitEndpoint, Sleep, SendEmail, ref } from "./src/sdk";

export function workflow() {
  return Sequence({
    id: "root",
    children: [
      HitEndpoint({
        id: "fetch-data",
        url: "https://httpbin.org/json",
        assignTo: "$.fetchResult",
      }),
      Sleep({
        id: "wait",
        seconds: 10,
      }),
      SendEmail({
        id: "notify",
        to: "user@example.com",
        subject: "Workflow Complete",
        body: ref("$.fetchResult.body.slideshow.title"),
      }),
    ],
  });
}
```

## Architecture

```
src/
├── sdk/      # Workflow authoring primitives
├── cli/      # CLI tool (postgit/pst)
├── server/   # REST API
├── engine/   # Execution engine & node handlers
├── worker/   # Polling worker with leasing
└── db/       # PostgreSQL persistence
```

## Durability Guarantees

- **At-least-once execution** — steps run to completion or retry
- **Crash recovery** — restart the worker and instances resume
- **Leasing** — prevents duplicate execution across workers
- **Exponential backoff** — failed steps retry up to 3 times

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | Postgres connection string | — |
| `PORT` | API server port | `3000` |
| `DC_API_URL` | API URL for CLI | `http://localhost:3000` |
