# Agent integration

## Bring your own MCP client

```sh
npm run serve
```

The server prints a random loopback URL and the path of a new owner-only `client-grant.json` file. Read that local file to obtain the temporary bearer token and approved input. Do not commit or paste the token into a model prompt.

A Codex configuration can reference it through an environment variable:

```toml
[mcp_servers.durable_tools]
url = "http://127.0.0.1:REPLACE_PORT/mcp"
bearer_token_env_var = "DTR_RUN_GRANT"
```

Replace the port with the printed address and set the token in the runtime's environment through your normal secret-handling mechanism. Use an isolated test configuration rather than modifying a production runtime. The meaning of `bearer_token_env_var` is documented in the [official Codex MCP guide](https://developers.openai.com/codex/mcp).

MCP discovery does not authorize arbitrary inputs. The example Grant is scoped to the printed approved intent and expires; new work needs an explicitly approved intent and a suitable Grant.

## Native runtime with simulated model responses

Install a compatible Codex CLI yourself and make `codex` available on PATH, or set `POC_CODEX_BIN`. Then:

```sh
npm run test:native
npm run agent:transport
npm run agent:cold -- after_commit
```

These commands do not call an external model. The mock provider label defaults to `fixture-model`; `POC_MODEL` may override that label for your runtime. The launcher checks an isolated filesystem permission profile before model execution. An incompatible CLI should fail the probe, not silently expand permissions.

The public candidate was validated with Codex 0.153.4 on macOS; see [publication provenance](publication.md) for the exact revision and results. Native compatibility is version- and OS-dependent; the default core CI does not certify native behavior on every platform. The current task renderer uses Chinese task instructions with language-neutral JSON fields.

## Optional live API acceptance

This public repository uses an explicitly provided API key through the documented Responses API endpoint. It does not import the predecessor's application-session relay.

Create an ignored `budget.local.json` with your model, current published prices and an explicit small budget. All fields below must be filled; the placeholders are intentionally not a runnable budget:

```json
{
  "model": "YOUR_MODEL_ID",
  "maxRequests": 12,
  "maxOutputTokens": 1024,
  "maxInputBytes": 512000,
  "maxEstimatedUsd": 1,
  "inputUsdPerMillion": "REPLACE_WITH_CURRENT_NUMBER",
  "outputUsdPerMillion": "REPLACE_WITH_CURRENT_NUMBER",
  "pricingSource": "https://developers.openai.com/api/docs/pricing",
  "pricingCheckedAt": "REPLACE_WITH_CURRENT_ISO_TIMESTAMP"
}
```

Set `POC_OPENAI_API_KEY` securely in your environment, then explicitly opt in:

```sh
POC_ALLOW_LIVE=1 npm run agent:acceptance -- normal budget.local.json
POC_ALLOW_LIVE=1 npm run agent:cold -- after_commit --live budget.local.json
```

The first entry also accepts `agent_restart`, `session_resume`, `worker_restart`, `combined_restart`, `lost_response`, `authorization`, `stale_epoch`, `cancel`, `unknown`, and `consumed`. The cold entry accepts the four scheduler cuts described in the walkthrough.

Live calls can incur charges. The local cost reservation is conservative and uses user-supplied price assumptions; it is not an authoritative provider billing cap. A missing response never implies that the provider did no work. Do not put keys in the budget file, command arguments, report or Git history.

The launcher exposes only the selected business MCP tools, disables shell/app features in its isolated configuration, and records public actions/outcomes rather than private reasoning. It is still a reference adapter, not a security certification of the installed runtime.
