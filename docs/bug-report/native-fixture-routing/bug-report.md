# Native simulated-tool routing

## Discovery and reproduction

The public-export validation discovered this regression at candidate `84608e336cdd01e3adb842eb610e37bb7f6fbb12`. Run `npm run test:native` with an installed Codex CLI. All four simulated-model cold-start cases failed before a reservation was executed; the commit-after-effect barrier could therefore never be reached.

Expected: a simulated Responses tool call reaches the governance MCP server, then the scheduler fault/recovery assertions run.

Observed: the fixture repeatedly received `unsupported call: inventory_reservation_submit`, eventually exhausted its own request ceiling, and the schedule became `BLOCKED`. The HTTP 429 was generated locally by the fixture, not by an external model provider. The retained reports showed zero inventory effects and no remaining owned processes.

## Root cause and bounded hypothesis

The public fixture uses a neutral simulated model label instead of relying on a particular model's tool-presentation metadata. Its tool discovery flattened namespace wrappers into bare function names. Direct function responses then omitted the namespace needed for routing. The existing code-mode discovery path did not exercise this case.

`tests/model-fixture.test.ts` reproduces the lost routing identity using an advertised namespace and asserts that the emitted function call retains it. Before the fix, the namespace was `undefined`; the flat-function and code-mode cases already passed.

## Change

Preserve each advertised function's namespace and return it in direct function calls. Keep bounded descriptor-only diagnostics so a native run can confirm the actual advertised shape. Do not hardcode a model or weaken grant, epoch, idempotency or unknown-outcome checks.

The native test now propagates its cancellation signal to the harness; fault waits also stop if the schedule becomes blocked. These changes prevent an impossible fault barrier from obscuring the original failure behind a later timeout.

## Verification

The targeted routing regression has completed RED/GREEN, including the unchanged flat-function and code-mode paths. Typecheck passes. The four native fault windows must be rerun to confirm the integration diagnosis; their result is recorded in [publication provenance](../../publication.md). They remain simulated-model evidence, not real-agent acceptance.
