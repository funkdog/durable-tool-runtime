# Native simulated-tool routing

## Discovery and reproduction

The public-export validation discovered this regression at candidate `84608e336cdd01e3adb842eb610e37bb7f6fbb12`. Run `npm run test:native` with an installed Codex CLI. All four simulated-model cold-start cases failed before a reservation was executed; the commit-after-effect barrier could therefore never be reached.

Expected: a simulated Responses tool call reaches the governance MCP server, then the scheduler fault/recovery assertions run.

Observed: the fixture repeatedly received `unsupported call: inventory_reservation_submit`, eventually exhausted its own request ceiling, and the schedule became `BLOCKED`. The HTTP 429 was generated locally by the fixture, not by an external model provider. The retained reports showed zero inventory effects and no remaining owned processes.

## Root cause and follow-up evidence

The public fixture uses a neutral simulated model label instead of relying on a particular model's tool-presentation metadata. Its tool discovery flattened namespace wrappers into bare function names. Direct function responses then omitted the namespace needed for routing. The existing code-mode discovery path did not exercise this case.

`tests/model-fixture.test.ts` reproduces the lost routing identity using an advertised namespace and asserts that the emitted function call retains it. Before the fix, the namespace was `undefined`; the flat-function and code-mode cases already passed.

Candidate `6666bcf` confirmed that namespace preservation restored the actual MCP calls: each of the four retained native reports contained exactly one inventory effect, including worker takeover at the after-commit barrier. The run still failed because the direct-MCP result was text prefixed with `Wall time: … seconds` and `Output:`, while the fixture expected bare JSON. It therefore resubmitted the same intent until its local request ceiling was reached. The business idempotency boundary held, but protocol completion did not. This is a second adapter mismatch, not a provider-rate-limit or inventory-consistency failure.

## Change

Preserve each advertised function's namespace and return it in direct function calls. Keep bounded descriptor-only diagnostics so a native run can confirm the actual advertised shape. Do not hardcode a model or weaken grant, epoch, idempotency or unknown-outcome checks.

Parse the specifically observed native timing envelope before parsing JSON; continue rejecting arbitrary error prose. The response-format regression includes plain JSON, the native envelope, MCP text content, a pending operation and an error. It failed at the native-envelope completion assertion before the parser change.

The native test now propagates its cancellation signal to the harness; fault waits also stop if the schedule becomes blocked. These changes prevent an impossible fault barrier from obscuring the original failure behind a later timeout.

## Verification

The routing and response-envelope regressions completed RED/GREEN. Candidate `e9dd1b0` then passed all four native fault windows, with one reservation effect per case and no remaining owned processes. Actual descriptors confirmed the `mcp__governance` namespace, and the fixture recognized the returned timing envelope. The complete result is recorded in [publication provenance](../../publication.md). These remain simulated-model observations, not real-agent acceptance. Both failed native batches are retained locally; no raw transcripts are published.
