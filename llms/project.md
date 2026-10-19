# Project setup and scaffolding

## Common tasks

### Start a project

`kay new` scaffolds a project that already checks, builds and runs, from a preset (`blank`, `server`, `site` or `app`) plus the features added or dropped:

```sh
bunx -p @kaynooo/kayjs kay new my-app --template app --without ws
```

### Set the project's settings

Settings live in a `kay.config.ts` at the root that `export default`s its config:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  routes: 'src/routes',
  lang: 'en',
  minify: true,
  prefetch: 'moderate',
  plugins: [],
})
```

### Serve the app's own routes next to the pages

Exporting `app` from the server entry lets links and redirects point at its GET routes and types `ctx.locals`:

```ts
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia()
  .get('/feed.xml', () => '<feed/>')
  .use(await pages())
  .listen(3000)
```

### Move an Astro project over

`kay migrate astro` translates the `.astro` files into `.kay` ones, writing into `--outdir` and never over a file that exists:

```sh
kay migrate astro ../my-astro-site --outdir ../my-kay-site
```

## Reference

### Project setup

- kay is published as `@kaynooo/kayjs` to the registry at `https://git.kaynooo.fr/api/packages/kaynooo/npm/` and installed under the name its imports use: `"kay": "npm:@kaynooo/kayjs@~<version>"` in `package.json`, a tilde since a minor release may break what the one before it took, each break listed in [Upgrading](upgrading.md) and every one `kay check` can recognise a `deprecated` lint with a fix, which `kay upgrade` applies as it moves the app, and a major is a rewrite, with `@kaynooo:registry=https://git.kaynooo.fr/api/packages/kaynooo/npm/` in the project's `.npmrc`.
- Before the first `kay new`, Bun is told once where the `@kaynooo` scope lives, in `~/.bunfig.toml`: `[install.scopes]` with `"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"`.
- `bunx -p @kaynooo/kayjs kay new my-app` writes a project that, after `cd my-app && bun install`, checks, builds and runs (`bun run dev`), both of those included: this setup, a layout, a page, a `_404.kay` and islands, or only what is picked of them (see [Commands](#commands) for the presets and features).

- kay runs on Bun 1.4.3 or later, as its `engines` says: the CLI and `pages()` refuse an older one, naming its version, its path and the fix, `bun update bun` when it is the project's npm `bun` package, which a plugin's peer dependency installs and package scripts run ahead of the system Bun.

- A folder of the project holding its own `package.json` or `kay.config.ts`, such as a workspace package or a second kay app, is a project of its own: `kay check` and `kay build` leave its files out of the app's, and the app reaches a package there through `node_modules`, as it would one installed.

- By hand, the server entry is:

```ts
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia()
  .get('/feed.xml', feed)
  .use(await pages())
  .listen(3000)
```

- Exporting `app` lets links and redirects point at the app's own GET routes, such as `/feed.xml`, which `kay check` otherwise reports as served by no page, and types `ctx.locals` (see [Locals](server.md#locals)).
- An entry other than `src/server.ts` is named once, as `entry: 'src/main.ts'` in `kay.config.ts`, which `kay dev`, `start`, `render`, `check`, `build` and `build --compile` all read; `--entry` on a command wins over it, `kay build --entry` also pointing its check step at that entry.
- An entry `kay check` does not read registers it instead: `declare module 'kay' { interface Register { app: typeof app } }`.

- Project settings live in an optional `kay.config.ts` at the root, read by `pages()` and every command; options passed to `pages()` or `testSite()` win over it key by key, an `undefined` option leaving the file's value, and in an executable `kay build --compile` wrote, the root, routes and public directory it was built with win over both.
- It must `export default` its config, or the command fails with a message saying so.

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  routes: 'src/routes',
  lang: 'en',
  minify: true,
  prefetch: 'moderate',
  plugins: [],
})
```

- A directory inside the project holding a `kay.config.ts` of its own, such as an example app or a documentation site, is another project: its components are never the outer one's islands, and it checks and builds from its own root.

- `proxy: false` is none, `proxy: true` is one proxy in front, `proxy: 2` two, `{ header }` a header the proxy sets ([Production](proxy-and-security.md#behind-a-proxy)).
- `extensions` lists what libraries add to the app, one value each, such as `extensions: [authPages()]`: pages laid over `src/routes` and API modules over `src/api` under a prefix, message catalogs under `src/messages`, an app file at the same path or an app key winning, config laid under the app's, such as Bun plugins or head tags (see [Extensions](component-libraries.md#extensions)), and a hook rewriting each prerendered page (see [Page hooks](prerendering.md#page-hooks)).

- `minify` is on for `kay build` unless set to `false`, and off for `kay dev` and a server bundling at boot unless set to `true`.
- `lang`, the `<html lang>` of every page when `i18n` is not set, defaults to `en`.

- Every page carries speculation rules, which the swap replaces on pages shipping its script (see [Navigation](navigation.md#navigation)): Chromium prefetches the page a link points at once it is hovered (`prefetch: 'moderate'`), on press with `'conservative'`, as soon as it can with `'eager'`, never with `false`.
- Links under `/_kay/` or `/api/`, with `download` or with `rel="nofollow"` are never prefetched; any other link that changes something on GET, such as a logout, takes `data-no-prefetch`.
- A stylesheet holding `@view-transition { navigation: auto; }` animates from page to page where the browser supports it, swaps included; `kay new` writes one inside `@media (prefers-reduced-motion: no-preference)`.

- `pages()` also takes `root`, `dev` (default: `NODE_ENV` is `development`) and `prebuilt` (default: `NODE_ENV` is `production`), which serves what `kay build` wrote instead of bundling at boot.
- A `.ts` file imports a component as `import Card from './card.kay'`, typed through the generated `.kay/types` tree, which `kay dev` writes again on every restart, from `kay.config.ts` as it is once it changed, the modules it imports as they were.
- `.kay/` also holds the client build and the compile cache.
- List it in `.gitignore`.
- `tsconfig.json` extends kay's, which merges that tree with the sources and is as strict as kay itself:

```json
{ "extends": "kay/tsconfig.json" }
```

- It includes `src`, `tests`, the `*.config.ts` files beside it, such as `kay.config.ts`, `eslint.config.ts` and `pg-orm.config.ts`, and `.kay/types`, relative to the project's tsconfig.
- A project adds its own `compilerOptions` beside `extends`, and an `include` of its own replaces kay's, so it lists `.kay/types` again; one setting up its tsconfig by hand needs `"jsx": "preserve"`, `"jsxImportSource": "kay"`, `"module": "Preserve"`, `"moduleResolution": "bundler"` and `"rootDirs": [".", ".kay/types"]`.

- `kay/html`, `kay/dom`, `kay/dom-image`, `kay/island`, `kay/await`, `kay/client`, `kay/arrival`, `kay/internal` and `kay/internal/server` are what compiled `.kay` files and kay's generated entries import: the compiler's output contract rather than API, free to change in any release, never imported by an app.
- `kay/library` is what kay's own libraries (kayjs-auth, kayjs-ui, kayjs-mail, kayjs-cms, kayjs-ai) share with kay for their server code, such as the sanitizer's lists, sealing, locale matching, escaping and the user a library names for a request (`nameUser(request, () => id)`, read back by `userOf(request)`: kayjs-auth names the signed-in user and kayjs-ai counts them), so neither keeps a copy: not API either, free to change with any minor, never imported by an app.

### Commands

- `kay new <dir> [--kay <dependency>] [--template blank|server|site|app] [--with <features>] [--without <features>] [--forge forgejo|github] [--runner <label>] [-y] [--quiet]`:
  - Scaffold a project in an empty directory.
  - A project is a set of features: `server` (an Elysia server; off, a static site), `starter` (a header, a skip link, a `_404.kay`, a home page greeting from the server with a counter island), `tailwind` (Tailwind through `bun-plugin-tailwind` over the Catppuccin Mocha palette; off, the markup carries no classes), `accents` (an accent picker in the header, kept in a cookie, which needs `starter` and `tailwind`), `eslint`, `tests`, `ci` (the workflow below, Forgejo's or GitHub's), `docker` (the container below; a static site's brings a `_404.kay` when `starter` is off, for its nginx 404), `auth` (the app's sessions, sign-in and members in SQLite, which needs `server`), `postgres` (the members in Postgres instead, with its compose stack and roles, which needs `auth`) and `ws` (the app's API module and websocket island, shown on the home page, which needs `server`).
  - A preset names a set: `blank` none, one layout and one bare page built as a static site; `server`, `site` and `app` as described below.
  - Run in a terminal with none of `--template`, `--with`, `--without` or `-y`, it asks for a preset, then shows its features as a checklist. Checking a feature checks what it needs, and unchecking one unchecks what needs it.
  - Otherwise it takes `--template`, `server` by default, adds the comma-separated `--with` features and drops the `--without` ones, and refuses a feature listed in both, or one missing what it needs (`kay: accents needs tailwind: add --with tailwind, or drop it with --without accents`);
  - `--forge forgejo|github` names where the repository lives (`--host` still works for now, with a warning that `--quiet` leaves out, as `kay dev --host` is an address), which decides the `ci` workflow: `.forgejo/workflows/*.yml` on a `debian` runner, or `.github/workflows/*.yml` on `ubuntu-latest` with `oven-sh/setup-bun` and, for an app with `postgres`, its Postgres service on `localhost:5432`; both run `kay check --format github`, so each problem shows on the diff, with `contents: read` permission alone (the Pages workflows add what publishing needs) and every action pinned to the commit of a release, its version in a comment. Without it the host is read from the `origin` remote of `dir`, or of the directory above it that exists, `github` for github.com and `forgejo` for any other remote or none. `--runner <label>` names another runner label for either.
  - Every project has the `.npmrc` naming the registry kay comes from.
  - The `server`, `site` and `app` presets have a layout with `seo` defaults and a skip link, a header with an accent picker over the Catppuccin Mocha palette, kept in a cookie, Tailwind through `bun-plugin-tailwind`, and Tabler icons.
  - `server`, the default, is an Elysia server, with a `Dockerfile` and `compose.prod.yaml` running the executable `bun run compile` makes.
  - `site` is a static site whose `bun run build` runs `kay build --static`, its pages showing the default accent until the picker hydrates, since no server reads the cookie, with a Forgejo Pages workflow publishing `dist` to the `gitea-pages` branch under `/<owner>/<repo>`, its `SITE_URL` a placeholder to replace with the host the Forgejo instance publishes Pages on (`--forge github`: a workflow deploying `dist` with GitHub Pages, `SITE_URL` and `SITE_BASE` read from the repository), and a `Dockerfile` serving it with `nginxinc/nginx-unprivileged` on port 8080 instead.
  - `app` is the server with sessions kept in `data/sessions.sqlite` (`sqliteStore`, on the `data` volume of its compose file, with Postgres too), a demo sign-in action, under any name, which production refuses unless `DEMO_SIGN_IN=true`, keeping its members in a SQLite file through `@kaynooo/pg-orm`, a guarded `/account` section, an API module and an island over its websocket, its session secret and development database written to a `.env` git ignores, `.env.test` holding a test-only secret and the test database, and `.env.example` naming what production sets;
  - The default `app` needs Bun alone: `.env` holds `DATABASE_URL=sqlite://data/app.db`, `data` is ignored by git and docker, `bun run dev` runs `pg-orm apply` before `kay dev` so the members table exists on the first start, `bun run db:generate` writes the next migration (SQLite DDL, from the tables in `src/db/`), `bun run test` gives each test file a copy of the migrated, seeded `data/test.db` (see [Testing](testing.md)) with no service in the workflow, and `compose.prod.yaml` mounts a `data` volume that a one-shot `migrate` service migrates and hands to `nobody`, the user the image runs as;
  - `--with postgres` (with `auth`, as in `--template app --with postgres`) swaps SQLite for Postgres: `docker compose up -d --wait` starts the database `compose.dev.yaml` describes, `bun run db:migrate` applies `migrations/`, `bun run db:generate` writes the next migration from the tables in `src/db/`, its `bun run test` gives each test file a copy of the migrated, seeded database (see [Testing](testing.md)), its workflow runs Postgres as a service, and `compose.prod.yaml` runs the database and a one-shot service applying the migrations before the app. Two Postgres roles split the work: the owner (`POSTGRES_USER`, connected by `MIGRATE_DATABASE_URL`, which `pg-orm.config.ts` reads before `DATABASE_URL`) changes the schema, and `app_rw` (the app's `DATABASE_URL`, password `APP_DB_PASSWORD`) reads and writes rows and cannot drop, alter or create anything. The database image creates `app_rw` from `db/roles.sh` when it first creates the database, with default privileges on tables, sequences and schemas, so a table a later migration creates needs no `GRANT`. An existing database runs `db/roles.sh` once, see [Upgrading](upgrading.md);
  - Every server preset's compose publishes the app on 127.0.0.1 alone, for a reverse proxy serving it over HTTPS, and its `kay.config.ts` sets `proxy: true` so rate limits count the visitor and not the proxy, its images and workflow use the Bun `kay new` ran under, and `.env` is ignored by git and docker and written readable by its owner alone;
  - `--kay` sets the `kay` dependency, by default `npm:@kaynooo/kayjs@~<its version>`, or a packed copy when run from a checkout of kay.
  - The package is named after the directory, lower case with other characters turned into `-`.
  - Every template's `tsconfig.json` adds `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride` and `noFallthroughCasesInSwitch` to `strict`, as kay does itself, so an optional field passed `undefined` must say `?: T | undefined`;
  - `server` and `app` carry a workflow checking, linting and testing the project on every push, and the `site` workflow tests it before building, which checks it, then lints it (see [Linting](checks.md#linting)).
  - Every project also has an `AGENTS.md` pointing coding agents at kay's docs for the installed version, through a `@node_modules/kay/llms.txt` line Claude Code expands at the start of a session, and naming the checks its scripts run; a project without one adds it by hand.
- `kay add <features> [dir] [--no-install] [--quiet]`:
  - Applies `kay new` features, comma-separated, to the project in `dir` (the current directory by default): the files and edits `kay new --with` would have made, then `bun install`.
  - The features the project holds are read off its files. A feature missing what it needs is refused naming the command that adds them together (`kay add server,auth`); `postgres` over an app on SQLite stops at the `.env` URL, which holds the data.
  - It writes only when every file has the shape `kay new` writes: a file both feature sets write differently (`_layout.kay`, `bunfig.toml`, `kay.config.ts`) is replaced while it is still what `kay new` wrote, `package.json` gets the scripts and dependencies it lacks (a script is replaced only while it is still the generated one), `.gitignore`, `.dockerignore` and `.env` get the lines or keys they lack, and `AGENTS.md` is left once edited; a deleted file is not written back and is named in the output. The CI workflow follows the `origin` remote (`.github` for GitHub, `.forgejo` otherwise), else the folder the project has, and the runner label is the one its workflow already runs on. Any other file, or a file that exists with other content, stops it with `kay add: nothing was written` and the lines to remove (`-`) and add (`+`) by hand.
  - `mail` and `cms` are features of kay's libraries: it adds `@kaynooo/kayjs-mail` or `@kaynooo/kayjs-cms` at kay's own minor, then writes what the package's `add` export says (`{ description, files?, extension?: { import, expression }, notes? }`) and adds the extension to `extensions` in `kay.config.ts`, which needs a plain `defineConfig({ ... })`.
- The other commands: `kay dev` is in [The dev server](dev-server.md), `kay build` and `kay start` in [Building and starting](build-and-start.md), and `kay check`, `kay render`, `kay screenshot`, `kay routes`, `kay env`, `kay doctor`, `kay i18n`, `kay upgrade`, `kay explain`, `kay fmt`, `kay lint`, `kay types`, `kay lsp` and `kay mcp` in [Check, inspect and tool commands](check-and-tools.md).
- `kay migrate astro [dir] [--outdir <dir>] [--format text|json] [--quiet]`:
  - Translate an Astro project's `.astro` files into `.kay` ones, `src/pages` into `src/routes` (`404` as `_404`), components and layouts kept in their folder with kebab-case names and the imports of them rewritten, and `src/content.config.ts` into kay's, its zod schemas written in `s`.
  - The frontmatter becomes the fence, a page's `--- server` with `Astro.url`, `params`, `cookies` and `redirect` read from `ctx`, `Astro.props` becomes `props<Props>()`, and the markup the indented template: static classes as the `.class` shorthand, `class:list` as `class`, `&&`, ternaries and `.map` as `if` and `for`, slots as `slot` and `@name` blocks, `client:idle` and `client:visible` as `hydrate`, `set:html` as `innerHTML` through `trustHtml`, a layout's `head` as a `head` block.
  - It writes into the project, or into `--outdir`, never over a file that exists, formats what it writes, and lists what it could not translate at its line in the Astro file: a script Astro bundles, an `await` or `Astro.url` in a component, an endpoint, markup written another way, each commented out under a `// kay migrate:` line where it stays in the code, and Tailwind 3, as kay builds with Tailwind 4.
  - An `--outdir` directory with no `package.json` gets the kay project around the pages, as `kay new` writes it without its home page, layout and stylesheet: a `package.json` with kay's scripts and the Astro project's packages, Astro's own left out, a `kay.config.ts` with the `site` and `base` of the Astro config and the layout's `<html lang>`, without `seo` defaults since the pages write their own head, a `tsconfig.json` keeping its `paths`, a server entry when the Astro config renders on demand (`output: 'server'` or an `adapter`), a static site otherwise, and Tailwind, ESLint, the Forgejo workflow and the Dockerfile when the Astro project had them;
  - Its other files under `src` and `public` are copied as they are, but for `src/env.d.ts`, which only Astro reads, those beside the pages moving with them into `src/routes`, where kay routes only `.kay` and endpoint files.
  - A Markdown page in `src/pages` is listed, to become a content collection's entry, and so is a `site` or `base` written as anything but a string.
  - Migrated in place, the Astro project's `package.json` stays as it is, listed with the Astro packages to remove, and the `lang`, `site`, `base` and tsconfig `paths` are listed to carry over by hand.
- Every command prints its usage for `--help` or `-h`, and refuses an option or argument it does not take with `kay <command>: unknown option --x` (naming a near option for a typo) and that command's usage line alone; `kay --help` and an unknown command list every command.
- `kay build`, `kay check`, `kay dev`, `kay fmt`, `kay migrate` and `kay new` take `--quiet`: the problems and one summary line (`kay build` one per step it ran, `--static` and `--compile` adding theirs), without the size report, the files one by one or the next step; `kay fmt --check` names the unformatted files alone; `kay dev` its ready line and errors, no line per restart or stylesheet swap; every other command refuses it.
- Colour only goes to a terminal, never under `NO_COLOR` or `TERM=dumb`, and `FORCE_COLOR` brings it back to a pipe; a redrawn line or a cleared screen only ever goes to a terminal.
- `kay build`, `kay routes`, `kay env`, `kay doctor`, `kay i18n missing`, `kay explain`, `kay fmt` and `kay migrate` take `--format json`, as `kay check` does: stdout holds one JSON document on one line, what the app's own code prints through the console or `process.stdout` going to stderr (a write straight to file descriptor 1 is not caught), and the exit code is the text output's.
  - `kay build`: `{ errors, warnings, problems }` as `kay check` prints them, a template that does not compile at its place and any other failure as one problem with `code: null`, then `failed: { stage }` when a stage stopped it, `built: { islands, stylesheets, prerendered, entries, ms, sizes, routes, stages, caches }` (`sizes` the entry's and each island's `raw` and `gzip` bytes, `modules` under `--analyze`, and per island `why` it is one and `promoted` for a static component that only may be; `routes` each route's `js` and `css` gzip bytes, the `islands` its pages render, `pages` prerendered, `kept` pages the build kept on its own and for a route rendered per request the `stop` that decided it and whether the scripts are an `estimated` reach; `stages` `{ name, ms }`; `caches` `{ name, cached, made }`), `exported: { pages, files, dir, ms }` and `compiled: { executable, ms }`; code that ends the process mid-build leaves the problems so far, one saying it ended and the stage, and exit code 1 for its `process.exit(0)`; `--format github` annotates the check's problems as `kay check` does, and a template that does not compile or a failed stage too.
  - `kay routes`: `{ routes, unlisted }`, each route's `methods`, `path`, `kind`, `by`, and `file`, `notes`, `layouts`, `guards` when it has them, every locale's copy with its chains.
  - `kay doctor`: `{ checks }`, each check's `name`, `ok`, `message` and, on a failure, `fix`.
  - `kay env`: `{ variables, unread }`, each variable's `name`, `source`, `type`, `required` (`'always'`, `'production'` or `false`), and `default` and `description` when it has them; `unread` the `file` and `error` of each module that failed to load.
  - `kay explain`: `{ groups, lints, errorGroups, errors }` with each lint's `name`, `group`, `level`, `since` when it has one and whole `summary`, and each error code's `name`, `group`, `summary` and `fix`; the errors only without a lint group named; or one lint's fields, its `wrong` and `right` examples included.
  - `kay fmt`: `{ errors, warnings, problems, written, changed }`, what does not parse as problems.
  - `kay migrate`: `{ written, kept, copied, notes }`, each note's `file`, `line`, `target` and `message`.
  - A command that cannot run, options that do not go together included, prints `{ errors: 1, warnings: 0, problems: [{ severity, code: null, message }] }`.
