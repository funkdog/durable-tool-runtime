# References and claim boundaries

External documentation explains the underlying protocols and mechanisms. It does not certify this project.

| Source | Used for | Not evidence of |
|---|---|---|
| [MCP tools, protocol revision 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | Discovery, calls, structured results and tool-error representation | This project's authorization or recovery correctness |
| [SQLite transactions](https://www.sqlite.org/lang_transaction.html) | Local transaction behavior and writer serialization | An atomic transaction spanning HTTP and two databases |
| [SQLite WAL](https://www.sqlite.org/wal.html) | WAL behavior and deployment constraints | Distributed database availability |
| [Codex MCP documentation](https://developers.openai.com/codex/mcp) | Explicit MCP endpoint and environment-based bearer-token configuration | Compatibility of every CLI release or this project's isolation policy |
| [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create) | The optional public API adapter's endpoint | Model availability or billing for a particular account |
| [MIT license text](https://opensource.org/license/mit) | The selected repository license | Licenses of separately installed dependencies |

Within this repository, [contracts](contracts.md) are the intended local rules, linked tests are executable checks, and [experiments](experiments.md) are observations with stated limitations. Keep those three levels separate when making a claim.
