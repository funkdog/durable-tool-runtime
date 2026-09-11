# Architecture

The central boundary is **durable acceptance**, not the lifetime of an RPC or an agent process.

```text
Trusted Controller ── approved intent + scoped Grant ──> Agent / MCP client
                                                          |
                                              MCP gateway / Core
                                                          |
                                     governance.sqlite: Operation + Event + Outbox
                                                          |
                                     Worker: claim → dispatch → inspect / settle
                                                          |
                                                  HTTP business adapter
                                                          |
                                     inventory.sqlite: intent + stock + receipt
```

The stores are independent. There is no transaction spanning both SQLite databases and HTTP. A response can disappear after the business transaction commits.

## Objects with different lifetimes

| Object | Meaning | Recovery action |
|---|---|---|
| Task and approved intent | Business identity and authorized input | Read durable identity; do not invent a replacement intent |
| Run | One agent execution and its predecessor | Preserve history; create a successor when needed |
| Grant | Current command authority over an explicit intent set | Reissue under current policy; never restore old authority from a checkpoint |
| Operation | Work already accepted by the platform | Continue the original responsibility |
| Worker lease / epoch | Current owner of an Operation's execution result | Claim atomically; reject stale finalization |
| Business observation | Evidence about effects in the backend | Validate identity, argument hash, state and version |
| Checkpoint | A set of visible operation references | Filter through the current Grant and load current facts |
| Event / consumer receipt | State changes and projection progress | Deduplicate delivery and reject older projection versions |

## Two epochs

`task_epoch` controls new producer commands. Core checks it in admission and cancellation transactions. Replacing an agent does not erase already-accepted Operations.

`executor_epoch` controls worker result commits for one Operation. Old workers can leave rejected observations, but cannot overwrite canonical state after replacement.

Neither integer is a universal remote fencing token. The inventory backend independently enforces its business identity and cancellation rules.

## Scheduler recovery

```text
scheduled task → current Run (READY = durable launch request)
                           |
                       scheduler
                           |
                  independent runner process
                           |
                       agent process
```

The runner atomically claims the Run before obtaining a Grant or calling a model. A repeated launch candidate may start as an OS process, but cannot become a second valid runner for the same Run.

The runner, not the scheduler, captures public runtime events and completion evidence. A replacement scheduler reads the same database. If an execution is lost, it fences old command authority before creating a successor with `previous_run_id`.

The local process adapter uses PID, start identity and an owned process group. This is a POSIX single-host adapter, not a distributed process registry. The model proxy and business services remain infrastructure outside the scheduler's lifetime.

## Runtime-independent business definition

`Catalog` resolves a trusted static implementation reference. The definition contains `executionMode`, authorization policy, backend consistency requirement, unknown-outcome policy and a digest. The adapter provides normalization, parameter authorization, business keys and evidence classification.

MCP publishes names, descriptions and schemas; those fields do not implement the business guarantees. A new backend requires new evidence rules and tests. See [contracts](contracts.md) and [security assumptions](../SECURITY.md).

## Source map

| Responsibility | Source |
|---|---|
| Approved intent / Grant | [controller.ts](../src/controller.ts) |
| Admission / query / cancellation | [core.ts](../src/core.ts) |
| Worker ownership / results | [execution-store.ts](../src/execution-store.ts), [worker.ts](../src/worker.ts) |
| Backend effect protocol | [inventory.ts](../src/inventory.ts), [backend.ts](../src/backend.ts) |
| Run lineage / scheduling | [run-store.ts](../src/run-store.ts), [scheduler.ts](../src/scheduler.ts) |
| Independent agent supervision | [runner.ts](../src/runner.ts), [codex-launcher.ts](../src/codex-launcher.ts) |
| Evidence-based final claims | [agent-verdict.ts](../src/agent-verdict.ts) |
