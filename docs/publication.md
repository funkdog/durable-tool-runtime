# Publication provenance

## Source cut

The public export was prepared from local research source revision `974ba7ec4bb0f2b3fb1188db56af94f7b340a0fa`. This hash is a provenance coordinate, not a claim that the predecessor repository or raw data is publicly accessible.

The public repository has fresh history. It does not import predecessor commits, local coordination metadata, account-session relays, raw databases or transcripts. The MIT license was selected by the repository owner.

## Deliberate public adaptations

- Native binaries resolve through PATH or `POC_CODEX_BIN`, not a developer's absolute path.
- Core checks and the deterministic MCP demo do not require an installed agent or model account.
- Native runtime tests are explicitly separated into `test:native`; they simulate model responses by default.
- Optional live runs use a dedicated API key and a caller-supplied model/budget through the public Responses API. No application login files are read by project code.
- The local data namespace was renamed; the public baseline is not a migration tool for predecessor experiment directories.
- Documentation separates normative contracts, executable tests and historical observations; historical model outcomes are not reassigned to a new public SHA.

## Validation record

The public candidate is validated with `npm run check`, `npm run demo`, and a separate native-runtime check. CI runs core contracts and the deterministic demo without model credentials. Exact run results are added after candidate validation; consult the PR checks for the current public revision.

Initial export candidate `84608e3` passed core checks and the deterministic demo but failed all four native simulated-model cases. A fixture dropped the advertised tool namespace; a targeted regression reproduced the problem before its fix. Candidate `6666bcf` restored MCP execution with one inventory effect per case, but its fixture could not parse the native timing wrapper around returned JSON, so all four still failed to complete. That observed envelope now has its own RED/GREEN regression. These failed batches are retained, not counted as successful recovery samples. See the [fixture investigation](bug-report/native-fixture-routing/bug-report.md).

The public-surface checker catches selected local references, credential-shaped content, runtime artifacts, symlinks and broken local links. It is not a complete secret scanner or a security review. The export is additionally limited to explicitly selected source files and newly written public documentation.

Publishing source, merging a pull request and creating a GitHub Release are separate actions. This baseline does not include an npm release, binary distribution or production-support commitment.
