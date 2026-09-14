# Experiments: evidence, not a success-rate claim

## Public baseline versus historical predecessor

This repository is a curated public export of a local research POC. The business state machines were retained, while installation paths, native-runtime configuration, public API entry points and documentation were adapted. Local application-session adapters, raw runtime databases and transcripts, personal paths and internal coordination records were not exported.

The historical results below belong to the predecessor. They are **not** fresh live-model results on the public commit. Public core/native validation is recorded separately in [publication provenance](publication.md) and CI.

## Historical campaigns

| Phase | Episodes | Model request attempts | Observation |
|---|---:|---:|---|
| Initial real-agent matrix | 17 | 66 | 10 initial passes; 7 not passed |
| Bounded replay of incomplete runs | 6 | 30 | 6 passes; one separate rejection-grader error reassessed from original evidence, no model replay |
| Scheduler cuts + serial controls + parallel matrix | 27 | 120 | 23 passes; one transport failure and three budget-censored runs |
| Authorized four-case completion | 4 | 18 | 4 passes, concurrency two, no request-count ceiling |
| Total | 54 | 234 | Mixed versions and selected replays; not a pooled reliability estimate |

Early smoke tests, deterministic MCP demos, mock-model tests and development conversations are excluded. A request attempt may be interrupted; it is not necessarily a completed model response or a unit of billing.

The original eleven scenarios cover normal execution, new-session and same-session recovery, worker and combined interruption, lost responses, authorization, stale task epochs, cancellation, unknown outcomes and irreversible consumption. Three paths include changed intent/warehouse/SKU/quantity variants. Four added cuts test scheduler loss before launch, after Agent start, after business commit, and before completion consumption.

## Two representative observations

**Scheduler/runner/worker interruption:** after a reservation committed, the governance result was absent. The replacement scheduler read durable Run lineage rather than receiving the old token or prior Run from the experiment driver. A replacement worker inspected the existing business receipt; a new Agent queried the original intent. Stock stayed at 7 and the reservation effect occurred once.

**Cancellation in the same session:** a completed reservation was followed by a new cancel goal and a read/cancel Grant. The model requested cancellation, then queried the compensation result. The original operation remained APPLIED, the compensation became APPLIED, the observation became RELEASED, and stock returned from 7 to 10.

These summaries describe real predecessor observations. They are not raw signed transcripts. Fresh deterministic and native runs generate their own local evidence.

## Failures were retained

- An early RunGrant implementation allowed future same-task intents. It was repaired with an immutable intent allowlist and regression tests.
- A grader discarded an actually received authorization rejection because the native tool event was marked failed. The original evidence was reassessed; no additional model call was required.
- An HTTP handler could leave a started stream open after an exception. A deterministic regression demonstrated and fixed that mechanism; it did not explain every early failure.
- The larger campaign retained a 120-request ceiling although observed normal paths suggested about 133 attempts before error margin. This was experiment-planning error, not failure of the budget guard.
- One report was captured before a worker finished during shutdown. Final snapshots were moved after execution shutdown. Old records were not overwritten.
- A historical normal-run transport error did not reproduce in the later instrumented completion. Its original root cause remains unknown.

## Interpretation limits

1. Recovery **within** an episode preserves the same business database and intent. Re-running a scenario in a fresh directory is not recovery of the original failed episode.
2. Parallel experiment jobs use separate business stores. Shared-resource contention is a separate deterministic test.
3. The weak backend hides capabilities but retains the local fixture implementation; it is not an evaluation of an actual non-idempotent vendor.
4. A matching structured final claim is not a complete natural-language or private-reasoning assessment.
5. Successful selective replays do not establish a production success rate, SLA, cross-runtime superiority or causal attribution to one code change.
6. Single-host PID and SQLite assumptions do not establish multi-host correctness under network partition or clock disagreement.

No raw login data, runtime transcript or customer data is published. This makes the historical account intentionally less independently auditable than a full raw dataset; the public tests and generated fresh-run reports are the reproducible component.
