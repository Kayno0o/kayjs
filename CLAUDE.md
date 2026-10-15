# kay

A Bun web framework: `.kay` components (pug-like templates over TypeScript), compiled to HTML on the server and to kay's own DOM runtime in islands. `llms.txt` and `llms/` are what an app's author reads; `src/` is the framework, `docs/` the documentation site built with kay itself (a workspace, so it imports kayjs-ui from `packages/`), `packages/` kay's libraries (kayjs-auth, kayjs-ui, kayjs-mail, kayjs-cms) as Bun workspaces, each with its own tests, `llms.txt` and eslint config. An issue about a library carries its label (`auth`, `ui`, `mail`, `cms`); kay's own issues carry none. Every issue also carries one priority: `priority/high` (breaks apps or CI, or blocks a migration), `priority/medium` (a real cost to apps or sessions) or `priority/low` (exploration, polish); a new issue gets one when filed.

## Design rule

Every feature asks the least of the app: the fewest declarations, the easiest setup, no workaround on the app's side. Prefer a design harder to build inside kay over one the app has to wire around.

## Workflow

Each session works alone, with no coordinator:

1. Take an open issue, the highest priority first (`tea issues ls -L priority/high`), with a comment naming the session (`tea comment <n> "Taken by session <name>."`), so no other session takes it; skip one whose latest comments show another session took it.
2. Work in a worktree (`just worktree <name>`), and commit with `bun run lint:fix` and the tests of what changed. A change heading for a `high` review first lists the cases a reviewer would try in the issue's **Cases** (each `base`, `trailingSlash`, locale, dev or production, island or server path, hostile input that reaches the code) and writes them as tests before the fix.
3. Review the commit once, through the `requesting-code-review` skill, at an effort matching the diff: none for docs, tests or a few lines, `low` for a contained change, `high` for the runtime, the compiler or anything an app sees. Its fixes go in a follow-up commit, not reviewed again unless they reshape the change; then a second, last review at `low` covers that follow-up alone, and what it finds short of Critical becomes a new issue rather than a third round.
4. `just land` (`scripts/land.ts`): one landing at a time, it rebases on origin's main, lints, checks, runs the tests the changes reach (`bun test --changed` plus the tests reading `llms/`, `docs/`, `examples/`, `packages/` or a fixture as files, the full suite for a root config, a library's own suite), pushes main and moves the main checkout to it. It prints one line per step, keeps their output in `land.log` in the worktree's git folder, and a failure ends on the step's failed tests and last lines, exiting 2 (uncommitted changes, nothing to land), 3 (conflict with main), 4 (a step failed) or 5 (push refused). It waits for another landing first, so run it in the background. Never run the full suite locally: CI runs it on every push, and a red run on main is fixed by whoever landed it; `just ci <sha>` waits for the run covering a landed commit and prints its failed tests.
5. Close the issue with `Fixed in <sha>`, remove the worktree, and tell the user the one line it landed as. An unlanded branch left behind is a comment on its issue, naming the branch and where it stands.

A session handing issues to subagents lands for them: a subagent goes through steps 1 to 3 in its worktree and returns at "ready to land", naming its worktree, its issue and whether steps remain. The session runs `just land` from that worktree in the background, then sends a failure's output back to the subagent to fix, does step 5 itself for a finished issue, or tells the subagent the sha it landed as to go on with the rest. A subagent leaves its worktree alone while it lands, as the landing rebases it.

## Checks

- `bun run check` is kay check (types, templates included). `bun run bench:check` checks every benchmark app, `bench:check:kay` the one on kay alone. A change under `packages/<name>` runs `bun run check` and `bun run test` in that folder too; the root lint already covers it, ESLint taking each file's nearest config.
- `bun test tests/<file>.test.ts` while working; the whole suite as `bun run test`, every file at once in this checkout (`bun test --parallel`, the slowest first by `tests/timings.json`, which `bun run test:timings` measures again), as CI runs it on half the cores. A test that writes into a fixture works on `fixtureCopy()` from `tests/scratch.ts`, and its scratch files go under `scratchDir()`, so no other file's build meets them.
- The slow files: `new.test.ts` (scaffolds and type-checks apps), `browser.test.ts` (Chromium through `BUN_CHROME_PATH`), `docs-contrast.test.ts` (builds the docs, axe-core in Chromium), `check.test.ts`, `forms.test.ts`.
- `examples.test.ts` and the app template's own tests run only with `TEST_DATABASE_URL`, a Postgres whose user may create databases.
- Test runs in one checkout wait for each other (`tests/one-run.ts`), as they build into the same `.kay` and fixtures; the workers of one parallel run share its turn. Work in parallel from a worktree instead: `just worktree <name>`, which Claude Code's own worktrees also go through (`.claude/hooks/worktree.ts`), starts at HEAD with its dependencies installed.

## A change is done when

- `llms/` and `docs/src/content/docs/` say what changed, in the same commit; `tests/llms.test.ts` and `tests/docs.test.ts` compile their `kay` blocks, check every lint is listed and keep `llms.txt` under 10,000 characters.
- A new lint has its entry in `llms/checks.md` and `docs/src/content/docs/reference/checks.md`.
- A feature an app sees adds its line, linking where it is documented, under `## Unreleased` in `llms/whats-new.md` and `docs/src/content/docs/guides/whats-new.md`, opening that section when it is the first; `just patch` and `just minor` name it after the version, and the release notes open with it.
- A breaking change adds what an app changes under the next minor's section of `llms/upgrading.md` and `docs/src/content/docs/guides/upgrading.md`, opening that section when it is the first.
- Breaking changes ship as minors; a major is a rewrite.

## Releases

`just patch` or `just minor` moves kay and every library to one version (`scripts/version.ts`: versions, each library's peer on kay's minor, the lockfile; `tests/packages.test.ts` holds them together), tags and pushes both at once; the tag's workflow publishes kay and each library not marked `private` to the Forgejo npm registry. A library's ranges on another are `workspace:~`, which publishing writes as that version.
