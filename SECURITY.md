# Security assumptions

This is a single-host research reference, not a hardened multi-tenant service.

- Bind only to generated loopback endpoints. Do not expose the demo gateway directly to the Internet.
- Treat the host, database, Controller, installed runtime binary, and implementation registry as trusted. Same-UID malicious processes and database administrators are outside this boundary.
- RunGrant is an opaque local credential with an immutable intent set. It is not OAuth, enterprise policy management, or a secret-management system.
- The model does not choose tenant, epoch, implementation code or its own authority. Credentials must remain outside prompts and tool arguments.
- Default tests never read an existing application's login files. Optional live tests require an explicitly provided API key and budget; do not put the key in a JSON budget file.
- Do not commit environment files, runtime directories, SQLite files, raw transcripts, or generated client credentials.
- Directory markers prevent accidental use of unrelated data. They are not a malicious-host security boundary.
- Request/response bounds and runtime deadlines remain relevant even if a trusted caller chooses an unlimited request counter.
- Tool annotations and descriptions are not authorization enforcement. Checks happen in Core and the downstream business transaction.
- Epoch checks on the governance store do not fence arbitrary remote services. Safe recovery depends on the actual backend contract.
- Cancellation may fail after irreversible consumption. Unknown outcomes must remain visible and require trusted intervention when safe reconciliation is unavailable.

For a suspected vulnerability, use GitHub's private vulnerability reporting if the repository offers it. Do not post credentials or live customer data in an issue. If private reporting is unavailable, open a minimal issue requesting a private contact without exploit details or sensitive data.

Dependency installation follows the lockfile, but this repository does not certify dependency security. Review your deployment, versions, authentication, egress and resource limits before adapting it.
