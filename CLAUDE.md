# kay

A Bun web framework: `.kay` components (pug-like templates over TypeScript), compiled to HTML on the server and to kay's own DOM runtime in islands. `llms.txt` and `llms/` are what an app's author reads; `src/` is the framework, `docs/` the documentation site built with kay itself.

## Design rule

Every feature asks the least of the app: the fewest declarations, the easiest setup, no workaround on the app's side. Prefer a design harder to build inside kay over one the app has to wire around.

## Checks

- Before a commit: `bun run lint:fix`, `bun run check` (kay check: types, templates included), `bun run bench:check` and the tests.
- `bun test tests/<file>.test.ts` while working; the whole suite as `bun run test`, every file at once in this checkout (`bun test --parallel`, the slowest first by `tests/timings.json`, which `bun run test:timings` measures again), as CI runs it. A test that writes into a fixture works on `fixtureCopy()` from `tests/scratch.ts`, and its scratch files go under `scratchDir()`, so no other file's build meets them.
- The slow files: `new.test.ts` (scaffolds and type-checks apps), `browser.test.ts` (Chromium through `BUN_CHROME_PATH`), `check.test.ts`, `forms.test.ts`.
- `examples.test.ts` and the app template's own tests run only with `TEST_DATABASE_URL`, a Postgres whose user may create databases.
- Test runs in one checkout wait for each other (`tests/one-run.ts`), as they build into the same `.kay` and fixtures; the workers of one parallel run share its turn. Work in parallel from a worktree instead: `just worktree <name>`, which Claude Code's own worktrees also go through (`.claude/hooks/worktree.ts`), starts at HEAD with its dependencies installed.

## A change is done when

- `llms/` and `docs/src/content/docs/` say what changed, in the same commit; `tests/llms.test.ts` and `tests/docs.test.ts` compile their `kay` blocks, check every lint is listed and keep `llms.txt` under 10,000 characters.
- A new lint has its entry in `llms/checks.md` and `docs/src/content/docs/reference/checks.md`.
- Breaking changes ship as minors; a major is a rewrite.

## Releases

`just patch` or `just minor` bumps, tags and pushes both at once; the tag's workflow publishes to the Forgejo npm registry.
