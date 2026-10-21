# Test databases and setup

How `bun test` gets a database, seeds it and switches the session store, for the tests in [Testing](testing.md).

## Databases and setup

- An app keeping its data with `@kaynooo/pg-orm`, as `kay new --template app` does, gets a database for each test file from `kay/test/preload` with no declaration: when the project has a `pg-orm.config.ts` and `DATABASE_URL` is set (`.env.test`), it copies a database migrated from the config's `migrationsDir` (`migrations` by default) with the config's tables, points `DATABASE_URL` at the copy before the app's modules read it, and drops it in `afterAll`. Keep `pg-orm.config.ts` to the tables and the config, and read the url from `process.env.DATABASE_URL`, not from a module of the app's that connects (without `--isolate` such a module keeps the original database for every file).
- What every file starts with on top of the migrations is the default export of `tests/seed.ts`, `export default async function seed(db: Database) { await db.repo(Member).write.insertOne({ name: 'Ada' }) }`, run once on the database the copies are made from; without the file the copies start empty. An app that wrote its own `tests/database.ts` with pg-orm's `testDatabase()` deletes it and its `bunfig.toml` line, moving its seed to `tests/seed.ts`.
- `bun test --isolate` runs each file in modules of its own, so each reads its own copy, and files never see each other's rows; the app's `bun run test` passes it, while a plain `bun test` runs the preload once and every file shares one copy.
- The test database in `.env.test` need not exist, a SQLite file is made on first use, and a Postgres server's user only needs `CREATEDB`.
- Without `browser`, pages render their islands' markup without scripts.
- `testSite()` still builds the islands for the browser, unminified, into `.kay/test-client` (`.kay/test-client-<n>` in a `bun test --parallel` worker), leaving what `kay build` wrote in `.kay/client` alone, and throws that build's error when one fails, such as an island reaching a Bun builtin or a server module (`browser-builtin-import`), which no server-side render meets.
- It runs once per process (once per file under `bun test --isolate`) for as long as the files under `src`, the routes and the API stay unchanged, one at a time, and `browser: true` shares it; `kay.config.ts`, `public` and library sources are not watched.
- `kay/test/preload` sets a 20 second default timeout for tests and hooks (Bun's `[test] timeout` does not reach hooks), or the `[test] timeout` of the working directory's bunfig.toml or the `--timeout` flag (read from `/proc`, so on Linux) when the project gave one, hooks included. On a large app the build may outlast it: pass `testSite({ islands: false })` there, or a longer timeout to `beforeAll`.
- Test files import `.kay` files directly, `import { add } from '../src/routes/index.kay'`, through `[test] preload = ["kay/test/preload"]` in `bunfig.toml`, which `kay new` writes along with a first test.
- They are typed through `.kay/types` as any `.ts` file's imports are, so `kay check` passes them, and a bare `tsgo` resolves them only once `kay check` has written that tree, which a check script runs first.
- `bun test` loads the project's `.env` as well as `.env.test` and `.env.test.local`, whatever `NODE_ENV` says.
- The preload drops every variable only `.env` sets, so a test never reaches the mail server or database a developer's `.env` names: tests see the shell's and the CI's variables and the test files', and `.env.test` need not blank what `.env` holds.
- The preload serves the project in the working directory, or the one `KAY_ROOT` names when it is nested, such as a library's fixture app run as `KAY_ROOT=tests/fixture bun test`, which `testSite()` then serves too.
- One test process serves one project: `testSite({ root })` on a second root throws, saying how to run it apart, as `bun test --parallel` (each file in a process of its own) or a `KAY_ROOT=<root> bun test <files>` run of its own.

Browser tests, with `testSite({ browser: true })`, are in [Testing in a browser](testing-browser.md).
