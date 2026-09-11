# Durable Tool Runtime

**Recover the task, not just the conversation.**

A small MIT-licensed reference implementation for durable agent tool execution, recovery, and side-effect control. It separates an agent's command authority from the platform's responsibility for already-accepted work.

[中文说明](README.zh-CN.md) · [Architecture](docs/architecture.md) · [Contracts](docs/contracts.md) · [Walkthrough](docs/walkthrough.md) · [Experiments](docs/experiments.md)

> Experimental, single-host software. Not a production workflow engine, a universal exactly-once layer, or an endorsement by an agent-runtime vendor.

## The failure this project explores

An agent asks to reserve inventory. The inventory service commits, but its response is lost. The agent, worker, or scheduler restarts. Repeating the whole task could repeat the business effect; trusting a transcript could invent success.

This implementation persists the accepted operation, queries business evidence, and resumes with the same intent. If the evidence or required backend capability is missing, it keeps the result unknown instead of guessing.

## Run the deterministic demo

Requires Git and **Node.js 24.16.0 or later**, with built-in SQLite **3.51.3 or later**. The program checks SQLite at startup. Core process tests target POSIX systems; Windows is not supported.

```sh
git clone https://github.com/funkdog/durable-tool-runtime.git
cd durable-tool-runtime
npm ci --ignore-scripts --include=dev
npm run check
npm run demo
```

No API key, model subscription, or installed Codex is needed for these commands. Tests use real local HTTP/MCP servers, SQLite databases and child processes, not a live model.

The demo starts at stock 10, reserves 3 once, kills a worker after the backend commit, reconciles the original operation, rejects stale authority, and releases the reservation once after cancellation. It also exercises a late write, duplicate event delivery and a backend without reconciliation capability.

Expected conclusion: `PASSED`. Each run prints its new temporary evidence directory. Databases and reports are retained locally; do not commit them.

## What is included

| Component | Responsibility |
|---|---|
| Controller and immutable RunGrant | Approve exact intents and inputs; issue scoped credentials |
| MCP gateway and Core | Validate every request; atomically accept an Operation + Event + Outbox |
| Worker and execution store | Claim work, reject stale results, inspect uncertain outcomes |
| Inventory backend | Atomically bind business identity, stock change and receipt |
| Scheduler and independent runner | Persist Run lineage, handle duplicate launch candidates, recover after scheduler loss |
| Checkpoint and projection examples | Restore references with current authorization; deduplicate state replay |

The business definition is not tied to Codex. MCP publishes the tool interface; the business implementation supplies authorization and recovery semantics. New business tools still need their own adapter, evidence rules and tests.

## Three explicit execution levels

| Level | Command | Requires |
|---|---|---|
| Core contracts and demo | `npm run check` / `npm run demo` | Node; no model |
| Native runtime, simulated Responses | `npm run test:native` or `npm run agent:cold -- after_commit` | Installed compatible Codex; no API key |
| Live model acceptance | `npm run agent:acceptance -- normal budget.local.json` | Explicit opt-in, dedicated API key, chosen model and budget |

Native tests resolve `codex` through PATH; set `POC_CODEX_BIN` to override. A simulated provider uses the label `fixture-model` by default; `POC_MODEL` can override it. Native compatibility must be checked separately from core CI. Live setup is documented in [Agent integration](docs/agent-integration.md).

## Read the guarantees before adapting it

- A timeout ends a wait, not necessarily the business operation.
- `ACCEPTED` is not `APPLIED`.
- `task_epoch` protects new agent commands; `executor_epoch` protects worker result commits.
- Compensation is a separate operation. History is not rewritten as “never happened.”
- A checkpoint restores references, not old authority or proof of current business state.
- Backend idempotency and resource-side rules matter; a gateway alone cannot retract an in-flight external write.

See the [normative project contracts](docs/contracts.md), [security assumptions](SECURITY.md), and [historical experiment limitations](docs/experiments.md). Historical live-model results were collected on a predecessor, not on this public export.

## Documentation authority

The [contracts](docs/contracts.md) define the intended local behavior. Named tests exercise those contracts. [Experiment reports](docs/experiments.md) describe observations, including failures. [External references](docs/references.md) provide protocol/background context; they do not certify this implementation.

## License and contributions

[MIT](LICENSE). Dependencies retain their own licenses. See [CONTRIBUTING](CONTRIBUTING.md) before changing a recovery or authorization contract. This repository is private to npm publishing (`private: true`); the source code itself is open source.
