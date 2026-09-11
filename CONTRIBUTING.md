# Contributing

Start with an issue describing the behavior, the failure window, expected evidence, and whether the concern is safety, liveness or reporting accuracy. Keep proposals scoped to a concrete business contract.

Before opening a pull request:

```sh
npm ci --ignore-scripts --include=dev
npm run check
npm run demo
```

For native-runtime changes, also run `npm run test:native` with a compatible installed Codex. State the runtime version and whether the model was simulated. Never call a paid model from default CI.

Changes to authorization, persistence or recovery must include a failing behavioral regression and its fix. Keep historical failures; do not replace them with a later successful run. Update the contract and named tests together.

Do not submit machine-specific paths, application login integrations, raw transcripts or databases. The public-surface checker is a heuristic; passing it is not a substitute for inspecting your diff and history.

Use small, readable modules and preserve the separation between agent command authority, accepted platform responsibility and downstream business effects. New backends must document inspect, idempotency, cancellation and evidence-consistency behavior explicitly.

Contributions are provided under the repository's MIT license. Third-party material must retain its applicable notices; do not copy code without verifying its terms.
