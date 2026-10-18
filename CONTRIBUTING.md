# Contributing to kay

Bug reports, fixes, docs and ideas are welcome. This page covers where each goes and what a pull request needs.

## Where things go

- **Bugs and feature requests**: a [GitHub issue](https://github.com/Kayno0o/kayjs/issues/new/choose), from its template.
- **Security issues**: never a public issue. [SECURITY.md](SECURITY.md) says how to report one privately.
- **Pull requests**: on GitHub. For a large change or a new feature, open an issue first, so the design is agreed before the code is written.

The GitHub repository mirrors the one at git.kaynooo.fr, where releases are cut and packages published. An accepted pull request is landed there by a maintainer and comes back to GitHub with the next push.

## Setup

kay needs [Bun](https://bun.sh) 1.4.3 or later.

```sh
git clone https://github.com/Kayno0o/kayjs
cd kayjs
bun install
```

The repository's `.npmrc` already points the `@kaynooo` scope at its registry. The libraries under `packages/` are Bun workspaces, installed with the rest.

## Layout

- `src/`: the framework: compiler, server, island runtime, CLI, language server.
- `packages/`: the libraries (kayjs-auth, kayjs-ui, kayjs-mail, kayjs-cms, kayjs-ai), each with its own tests, `llms.txt` and ESLint config.
- `llms.txt` and `llms/`: the full reference, dense, written for coding agents.
- `docs/`: the documentation site, plain prose for people, built with kay itself.
- `examples/`: the tutorial's app and an app using every library.
- `tests/`: kay's tests, with their fixtures.
- `editors/vscode/`: the editor extension, on `kay lsp`.

## Checks

Run these before opening a pull request:

```sh
bun run lint:fix                 # ESLint, .kay files included
bun run check                    # types, templates included
bun test tests/<file>.test.ts    # the tests of what you changed
```

A change under `packages/<name>` also runs `bun run check` and `bun run test` in that folder. A library's tests run against the app in its `tests/fixture`, which installs the library as an app does, linked back to the checkout. Two of them need more:

- kayjs-auth tests its Postgres store against the database in its `docker-compose.yml`: run `docker compose up -d` in `packages/auth` first, or set `KAYJS_AUTH_TEST_DATABASE_URL`.
- kayjs-ui and kayjs-cms also run DOM tests on happy-dom, from `tests-dom`.

`bun run test` runs the whole suite in parallel. It is slow, and CI runs it on every push, so the tests of what you changed are usually enough. Some tests need more than Bun:

- The browser tests drive Chromium, named by `BUN_CHROME_PATH`.
- `tests/examples.test.ts` and the app template's tests run only with `TEST_DATABASE_URL`, a Postgres whose user may create databases.

A test that writes into a fixture works on `fixtureCopy()` from `tests/scratch.ts`, so it never changes the checkout.

`bun run docs:build` builds the documentation site into `docs/.kay`, and `bun run docs:start` serves it.

## What a change includes

- **A test.** A bug fix comes with a test that fails without it.
- **The docs.** `llms/` and `docs/src/content/docs/` say what changed, in the same commit. `llms/` stays dense; the site reads as short, plain sentences. `llms.txt` stays under 10,000 characters, which `tests/docs.test.ts` checks.
- **A new lint** has its entry in `llms/checks.md` and `docs/src/content/docs/reference/checks.md`.
- **A breaking change** adds what an app changes to the next minor's section of `llms/upgrading.md`. Breaking changes ship in minor releases; a major is kept for a rewrite.

Every feature should ask the least of the app using it: the fewest declarations and the simplest setup. A design that is harder to build inside kay beats one each app has to work around.

## Commits

Commit titles follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): title`, with `!` after the scope for a breaking change. A library's scope is its name (`auth`, `ui`, `mail`, `cms`, `ai`). The title says what changed as an app sees it:

```
fix(session): a running server reopens its sqlite session file once deleted or replaced
```

## Releases

kay and its libraries are released together, at one version, by a maintainer. Each library peers on kay's minor as a tilde range, `~<major>.<minor>.0`, since a minor may break. `scripts/version.ts` moves every version and peer range for each release.

## Code of conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE), as the rest of kay is.
