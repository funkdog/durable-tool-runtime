# Contributor automation rules

- This is an experimental local reference implementation, not a production platform.
- Use fresh isolated test data. Never point experiments at existing user databases.
- Preserve business intent identity, grant boundaries, and unknown-outcome semantics.
- A changed contract needs a failing behavioral test before the implementation change.
- Never use conversation transcripts or checkpoints as authorization.
- Do not read existing application login credentials. Live tests require an explicitly supplied API key, model and budget.
- Default checks must not call a model or require a locally installed agent runtime.
- Keep native-runtime tests separate and identify simulated versus live model evidence.
- Do not include credentials, raw transcripts, databases or machine-specific paths in commits.
- Preserve failed experiment records; do not retry until green or mislabel selective replays as reliability estimates.
- Do not claim self-review as independent review.
