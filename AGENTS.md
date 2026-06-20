# AGENTS.md — conventions for this repo

Headless cross-agent session capture. Two npm-workspace packages: `schema`
(publishable contract) and `agent` (daemon + CLI + insights + analytics).

## Ground rules

- **TypeScript, ESM, Node ≥ 20.** Extensionless relative imports
  (`moduleResolution: Bundler`). Tests/dev run TS directly via vitest/tsx — no
  build step needed to test.
- **Tests are mandatory.** Every module has a `*.test.ts` beside it. Run
  `npm test` (vitest). Keep it green before claiming done.
- **`schema` is the contract.** Anything written to the store goes through a zod
  schema in `packages/schema`. Add a new field → bump the `schema` version tag
  and the validators. The VSCode extension consumes this package.
- **The store is the source of truth, not a cache.** Per-turn files are
  **immutable / write-once**; aggregates (`session.json`, `insights/labels.json`,
  `analytics/*`) are **derived/rebuildable**. Never make a writer that mutates a
  turn file.
- **Conflict-freedom is a design invariant.** Paths are keyed by `host` +
  `session-uuid`. Don't introduce a shared mutable file two hosts both write.
- **Hygiene at the door.** All capture goes through `applyHygiene` (scrub +
  size-cap + externalize). Don't bypass it.
- **Hooks must never break the agent.** The `hook` command swallows all errors
  and exits 0. Keep it that way.

## Layout

```
packages/schema/src   schemas.ts · normalize.ts · validators.ts
packages/agent/src    config · capture · daemon · ipc · state · tail · hygiene · pricing
  store/              paths · writer · git · scan
  insights/           provider · heuristics · llm · labeler
  analytics/          rollup · digest · site · command
  hooks/              install · shim
  cli.ts · cliargs.ts · commands.ts
```

## Commands

```bash
npm test          # vitest (all packages)
npm run typecheck # tsc --noEmit
npm run build     # tsup -> dist (schema emits .d.ts; agent emits JS)
```

## Adding a capture adapter (e.g. Codex)

1. Add `normalize<Agent>Event` + `extract<Agent>SessionMeta` in `packages/schema`.
2. Branch on `agent` in the capture engine; keep `raw` passthrough for resume.
3. Add golden-file tests with a real fixture transcript.
