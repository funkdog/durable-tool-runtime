# Project contracts

This document defines the intended behavior of this reference implementation **under the assumptions in [SECURITY](../SECURITY.md)**. It is not an extension to the MCP specification or a promise for arbitrary third-party services. A mismatch between code, tests and this document is a project defect.

## Invariants and executable evidence

| ID | Contract | Named test source |
|---|---|---|
| C1 | An identical approved intent resolves to one durable Operation; changed arguments are rejected | [core](../tests/core.test.ts), [boundaries](../tests/boundaries.test.ts) |
| C2 | A Grant cannot gain access to future or other-task intents | [grant-intents](../tests/grant-intents.test.ts) |
| C3 | Operation, initial event and outbox entry commit together | [core](../tests/core.test.ts) |
| C4 | A stale producer cannot submit new commands; accepted work remains | [core](../tests/core.test.ts), [integration](../tests/integration.test.ts) |
| C5 | A stale executor cannot finalize a replacement's Operation | [execution](../tests/execution.test.ts) |
| C6 | Uncertain dispatch is inspected before any conditional retry; absent capability blocks | [boundaries](../tests/boundaries.test.ts), [recovery](../tests/recovery.test.ts) |
| C7 | Compensation is separate; consumed inventory cannot be released | [inventory](../tests/inventory.test.ts), [boundaries](../tests/boundaries.test.ts) |
| C8 | Duplicate/older projection deliveries cannot regress state | [core](../tests/core.test.ts) |
| C9 | A checkpoint returns only currently visible references and fresh facts | [recovery](../tests/recovery.test.ts), [grant-intents](../tests/grant-intents.test.ts) |
| C10 | Duplicate scheduler candidates have one effective runner; completed evidence is not restarted | [scheduler-state](../tests/scheduler-state.test.ts), [native process tests](../tests/native/scheduler-process.test.ts) |
| C11 | Final snapshots are taken after execution shutdown | [final-snapshot](../tests/final-snapshot.test.ts) |
| C12 | A final model claim needs matching tool evidence received before the claim | [agent-verdict](../tests/agent-verdict.test.ts), [acceptance-failures](../tests/acceptance-failures.test.ts) |

## MCP surface

| Tool | Input | Result semantics |
|---|---|---|
| `inventory_reservation_submit` | `intentRef`, `warehouseId`, `sku`, `quantity` | Durable acceptance; may return an already-existing operation. Not synchronous business success. |
| `operation_get` | Exactly one of `operationId` or `intentRef` | Execution facts, latest **recorded** observation, and separate compensation status. Does not execute or retry work. |
| `operation_cancel_request` | Original reservation `operationId`, optional `reason` | Records cancellation intent and creates compensation if needed. Not instant rollback. |

Inputs are strict schemas. The caller cannot supply a tenant, epoch or implementation reference to select its own authority. Every relevant operation repeats authorization checks, including duplicate submit/cancel paths.

Grant `allowed_intent_refs_json` is an immutable snapshot of explicitly selected existing intents. Query and cancellation outside that set return `NOT_FOUND`; the caller does not gain task-wide visibility. Managed Runs exist before launch and Grants bind them. The convenience Controller API can create an unmanaged Run when no Run ID is supplied.

## Execution states

```text
ACCEPTED → DISPATCH_RECORDED → APPLIED / NOT_APPLIED
                    |
                    └→ OUTCOME_UNKNOWN → evidence-based reconciliation or block
```

- `ACCEPTED`: platform responsibility is durable.
- `DISPATCH_RECORDED`: a pre-dispatch record exists; not proof that the request left the process.
- `APPLIED`: the original action happened. Later compensation does not rewrite it as never having happened.
- `NOT_APPLIED`: evidence shows that this action did not apply.
- `OUTCOME_UNKNOWN`: insufficient evidence. Neither success nor proof that retry is safe.

`desired_action=CANCEL` is a desired action, separate from execution state. Before dispatch, cancellation can terminate the original operation. After dispatch, a separate child Operation records compensation.

The inventory backend transitions `RESERVED → RELEASED`, rejects release of `CONSUMED`, and can create a `CANCELLED` tombstone before a delayed reservation reaches the effect boundary. The business record and its stock mutation are atomic inside the inventory database.

## Error classes

- Invalid/expired credentials, missing scopes and stale task authority reject new commands.
- A transport error ends a wait, not necessarily the business operation.
- An MCP result with `isError` can be valid evidence of a business/authorization refusal.
- Backend capability or evidence failures remain blocked/unknown; no “force success” tool is exposed.
- Request/cost budgets and runtime deadlines are separate limits. Missing response or usage information does not refund a reserved attempt.

The code does not promise constant availability, fairness, cross-host lease correctness, tamper-proof databases, general schema migration or arbitrary remote exactly-once execution.
