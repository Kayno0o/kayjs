# Check, inspect and tool commands

## Common tasks

### Check the project

`kay check` type-checks the project, `.kay` files included, and fails on errors, and on warnings with `--deny-warnings`, which the `check` script `kay new` writes leaves out:

```sh
kay check --deny-warnings
kay check --fix
kay check --format github
```

### List the routes the project serves

`kay routes` lists pages, actions, endpoints and API routes without running a page or a guard:

```sh
kay routes
```

### Check what a page renders

`kay render` prints the HTML the server answers for one URL, as `kay dev` serves it, without starting a server; what the server logs goes to stderr, and a status of 400 or above exits 1:

```sh
kay render /about
kay render /account --cookie session=…
```

### Screenshot a page

`kay screenshot <path>` shoots a page of the project's running `kay dev` in a headless Chrome or Chromium (`BUN_CHROME_PATH`, else the PATH) and writes PNGs under `.kay/screenshots/`, 375 and 1280 px wide by default, for a layout the HTML does not show:

```sh
kay screenshot /admin/posts
kay screenshot /admin/posts --width 375 --scheme dark --full-page
kay screenshot /account --cookie session=abc123
```

### Give an agent kay's tools

`kay mcp` serves the project in the current directory as an MCP server over stdio, for an agent to call instead of running `kay` in a shell. It needs nothing in the app: the agent's client starts it from the project's root, where kay is installed.

```sh
claude mcp add kay -- bunx kay mcp
```

Another client takes the same command in its MCP config, such as `.mcp.json` at the project's root for Claude Code (a client may name the key `servers`):

```json
{ "mcpServers": { "kay": { "command": "bunx", "args": ["kay", "mcp"] } } }
```

The tools are `check` (`paths`, `only`, `denyWarnings`), `routes`, `explain` (a lint or an error code, `name`), `render` (`url`, `method`, `body`, `headers`, `cookies`), `screenshot` (`path`, `width`, `height`, `scheme`, `fullPage`, `cookies`, `diff`) and `dev_errors` and `doctor` (`port`); the resources are `kay://llms.txt` and one `kay://llms/<file>.md` per guide, each listing its sections. See [Commands](project.md#commands).

### Format the templates

`kay fmt` formats `.kay` files, and `--check` lists the unformatted ones and fails. In an app that imports Tailwind, it sorts the shorthand's classes in Tailwind's order, with the words of the `class` attribute they move into, and sorts nothing before the app is installed. It moves the shorthand classes of an element past 120 characters into a `class` attribute over several lines (see [Elements](templates.md#elements)):

```sh
kay fmt
kay fmt --check
```

## Reference

### Check and inspect commands

- `kay check [dir] [paths...] [-p tsconfig.json] [--entry <file>] [--deny-warnings] [--fix] [--dry-run] [--only <group>] [--since <minor>] [--format text|github|json] [--watch] [--quiet]`:
  - Type-check the project, `.kay` files included;
  - The first path is the project when it is a directory holding a `kay.config.ts`, `package.json` or `tsconfig.json`, or any directory outside the current directory, so a directory given first to narrow the report must be neither;
  - The other paths, files or directories relative to the current directory, a symlink read as what it points to, narrow the report, and `--fix`, to the problems in them, the project still checked as a whole, and one outside the project fails the check;
  - `--watch` checks again on every change, tests included, each check a `kay check` of its own, so an edit to `kay.config.ts` counts and a check that cannot run, or exits before reporting, leaves the watch going, clearing the previous report in a terminal, and an interrupt or a closed terminal stops the check running and what it started, a second interrupt killing them;
  - `checks: [fn]` in kay.config.ts (a library's `extensions` config may add its own) runs the app's own checks with kay's, so they get its text, `--format json` and `github` output, the MCP `check` tool, `--watch` and its exit code. Each `fn({ root, routes, report })` may be async: `report({ level, message, file, line, column, code })` adds a problem, `level` being `'error'` (the default) or `'warning'`, `file` relative to the project (kay.config.ts by default) and `line` and `column` 1 by default; `await routes()` gives what `kay routes` lists, read once, when a check asks. A check that throws, or does not finish within 30 seconds, is one error naming it as `checks[n]`, and the others still run. They run once, after `--fix`, and `--only` and `--since` leave them out; a path given to narrow the report keeps the findings in it.
  - `-p` is relative to `dir`, and a tsconfig that is missing or matches no files fails the check.
  - `--dry-run` counts the fixes `--fix` would apply (`would fix 3 problems`) and writes nothing.
  - `--since 1.46` reports and, with `--fix`, fixes the `deprecated` lints that came in that minor alone, as `kay upgrade` runs it; it does not go with `--only`.
  - `--entry` names the server entry whose `app` types `ctx.locals` and the app routes, `src/server.ts` by default, as `kay build --entry` does (see [Locals](server.md#locals)).
  - It fails on errors, and on warnings too with `--deny-warnings` (see [Lints and warnings](lints.md#lints-and-warnings)).
  - `--fix` first applies the quick fixes that change nothing else, removing an unread prop or writing `onclick` as `onClick`, (with `env` in kay.config.ts, also the raw `process.env.X` reads `kay env` warns of: each is declared in the app's `export const env = defineEnv(s.Object({` or a new `src/env.ts`, a `?? 'default'` becoming its default, the reads becoming `env.X`; one assigned, destructured, in a `.kay` file or beside an `env` of its own keeps its warning, a rewritten file loads the schema, which checks the environment on import, and `kay upgrade` skips it), then reports what is left; the others, such as a key or a `maxLength` to choose, stay the editor's.
  - `--only seo` prints one group's lints alone, as an audit (see [Lints and warnings](lints.md#lints-and-warnings)).
  - `--format github` prints each problem as a workflow command, `::error file=...,line=...,col=...::message`, which GitHub and Forgejo Actions show on the diff, as the CI `kay new` writes does, its `file` relative to `GITHUB_WORKSPACE`, the repository's root, when set;
  - `--format json` prints `{ errors, warnings, problems }` on stdout, each problem's `file` relative to the current directory with its `line`, `column`, `endLine`, `endColumn`, `severity`, `code` and `message`;
  - A check that cannot run, on a path that does not exist or a `kay.config.ts` that does not load, prints one error in the format too, with no `file` but where a config does not parse;
  - The exit code is the same in every format.
  - It also reports what the server would refuse when it boots, with the same functions: two pages serving one path, a redirect from a path a page serves or with syntax the router refuses, a page under a locale's prefix, a public file a page serves, two files whose actions share a URL (`a b.kay` and `a_b.kay`), a `base`, `site`, `shutdownTimeout`, `health.timeout`, `live`, `requestIdHeader`, `images.remoteMaxSize` or `images.remoteTimeout` it cannot read, a collection feed without `site`, and a guard, API module or matcher whose default export is not a guard, an Elysia instance or a function.
  - `kay build` reports them as it checks, and the editor after a save or a change on disk.
- `kay render <url> [dir] [--method <method>] [--body <text>] [--header <name: value>]... [--cookie <name=value>]... [-i|--include] [--entry <file>]`:
  - Answer one request as the server entry answers it under `NODE_ENV=development`, as `kay dev` serves it but without the inspector's attributes, and print the body on stdout; the server runs on a Unix socket of its own, not a port, stops once it answered, or starts stopping within a second once `kay render` is killed, and builds the browser code into a directory under `.kay` it removes, never touching `kay build`'s or `kay dev`'s; the next `kay render` removes what a SIGKILLed one left.
  - What the server logs, a page's error report included, goes to stderr; a redirect prints `kay render: 302 Found, to /login` there and exits 0, a status of 400 or above prints its line there and exits 1, and a server exiting before it serves fails with its code.
  - `--body` posts as a form does, `application/x-www-form-urlencoded`, unless a `--header` names another `content-type`; `--header` and `--cookie` repeat, a guarded page rendering signed in with the session cookie a browser holds; `-i` prints the status and headers on stderr.
  - Under `base`, a path under it is taken as the proxy in front of the server hands it over, so a link a page printed renders as it is.
  - The whole app boots for it: its jobs and modules' top-level code run, and a `POST` to an action runs it against the app's database. The request goes to the first server the entry starts, with the host a full URL names, over plain HTTP; a server not listening after 60 seconds fails it.
- `kay routes [dir] [--format text|json]`:
  - List the routes the project serves, without running a page or a guard: each page's pattern with its matchers, `/items/:id=integer`, and file, once per locale's path (`/about`, `/fr/a-propos`), with its layouts and guards, outermost first, `prerendered` with `prerender: true` or a server island, `prerendered as its prerender setting lists` with a list or a function, `open` with `guards: false` and the 403 `requireGuards` gives one with no guard;
  - Each action, endpoint, API module route with its method, `WS` and `OPTIONS` included, and a library's with the guards of its own directory (API modules are imported, as only they know their routes, so their top-level code runs: what it writes to stdout, through the console or `process.stdout`, goes to stderr, and one that fails to load or calls `process.exit()` is listed by its mount with why), the routes of an extension's `server` given as an Elysia instance, each redirect and collection feed;
  - And kay's own routes the config turns on, such as `/_kay/health`, the favicons and the sitemap.
  - What the server entry adds, as a `.use(auth.plugin)`, and an extension's `server` given as a function are only known as the server starts: a last line names them, unlisted.
- `kay not-found [dir] [--redirect <path> [--to <target>] [--runtime] [--dry-run]] [--format text|json]`:
  - Lists the paths visitors asked for with a GET and found nothing at, most hit first, from `data/not-found.sqlite` (or `--file`), with the hosts they came from and a suggested target; those a `redirects` entry answers already are left out ([Redirects](routing-endpoints-and-base.md#redirects));
  - `--redirect <path>` adds the redirect to `redirects` in kay.config.ts, to `--to` or to the suggested target, and drops the path from the list; a config with no object literal to add it to prints the line to add by hand;
  - `--runtime` writes it to the file instead, which the running site reads with no deploy and no change to kay.config.ts; the rules are those of [Redirects](routing-endpoints-and-base.md#redirects), and `kay check` reports such a target nothing serves.
- `kay doctor [dir] [--port <port>] [--format text|json]`:
  - Checks, one line each (`ok` or `FAIL` with a `fix:` line under it), what can keep a project from running, and exits 1 on any failure, the others still running: `bun` (the version kay needs), `versions` (`@kaynooo/kayjs` and each `@kaynooo/kayjs-*` listed in package.json installed, the libraries on the minor of kay's), `config` (kay.config.ts loads), `env` (each variable `kay env` lists as `always` required is set in the shell or the project's `.env` files, or `production` ones too under `NODE_ENV=production`), `port` (`--port`, else `PORT`, else 3000, free to listen on at `HOST` or else on every IPv4 address and both loopback ones, `0` meaning the system picks, or held by this project's own `kay dev`) and `build` (`.kay/client` and `.kay/dev` built by this kay: `kay build` and `kay dev` stamp `kay` in their `manifest.json`, so a build by another kay or by one before the stamp fails).
  - `--format json` prints `{ checks }`, each with `name`, `ok`, `message` and, on a failure, `fix`; the MCP `doctor` tool answers the same document, a failing check being a result.
- `kay env [dir] [--compose <file>]... [--example <file>] [--write] [--format text|json]`:
  - Lists the environment variables the project declares, for a deploy script to compare with a compose or an env file: each `defineEnv` schema in the modules under `src` (imported without the server's environment, so their top-level code runs and its output goes to stderr; the server entry is not run, and a schema it declares is not listed; a schema built inside a function is not seen), `publicEnv`, the `env` schema of each extension, and kay's own `PORT`, `HOST`, `SITE_URL`, `ORIGIN` and `KAY_SECRET`;
  - Each with its source, type, whether it is required (`always`, `production` for a field with `requiredInProduction: true`, or `optional`) and its default; a module that does not load is named as not read.
  - With `--compose` and `--example`, or `env` in kay.config.ts, compares them with those files, else with the project's production `compose*.yaml` and `.env.example`, and exits 1 on an error; `kay check` does the same. `--write` appends the declared variables the example lacks ([Server](server.md)).
- `kay i18n missing [locale] [dir] [--format text|json]` and `kay i18n accept <locale> [dir] [--dry-run]`:
  - List what each locale lacks against the default one, messages and localized entries; accept a locale's draft messages, deleting their `// draft` comments (see [Locales](locales.md#messages)).
  - `kay i18n` alone lists every `i18n` command, those a library adds included, such as `kay i18n translate <locale> [--dry-run]` of `@kaynooo/kayjs-ai`, which fills the missing messages and entries as drafts.
- `kay upgrade [dir] [--dry-run] [--quiet]`:
  - Move the `kay` and `@kaynooo/kayjs-*` ranges of `package.json` that are version ranges of the registry, `npm:@kaynooo/kayjs@~1.45.0` or `~1.45.0` (a path, workspace or git source is left), to `~<latest>` with the registry's answer, install, then run the installed kay's `kay check --fix --since <minor>` once per minor between the version the app was on and the one it moves to, oldest first, listing them from the installed kay's `kay explain deprecated --format json`, then `kay check --fix`, which prints what is left to do by hand and sets the exit code.
  - `--dry-run` lists the packages it would move and writes, installs and rewrites nothing.
  - An app already on the latest is left as it is, a registry older than the app's range never moves it back, and a failed install puts `package.json` back as it was. A deprecated form is one `deprecated` lint with its `since` minor and a safe fix; a minor's breaking changes carry one when `kay check` can see the old form, see [Checks](checks.md).
- `kay explain [lint|error|group] [--format text|json]`:
  - List the lints with their groups and default levels and the errors with theirs, or a group's, or print one: a lint with an example it reports and the same written right, an error with where its fix is written.
- `kay fmt [paths...] [--check | --dry-run] [--format text|json] [--quiet]`:
  - Format `.kay` files; `--check` lists unformatted files and fails, `--dry-run` lists them and succeeds (not both).
- `kay fmt --from-html [file] [--format text|json]`:
  - Print the HTML in `file`, or on stdin (`-` too), as a formatted `.kay` template, through the translation `kay migrate astro` uses: tag shorthand, static classes as `.class` and the id as `#id`, `class="..."` kept for a class the shorthand cannot hold (an unclosed `[`), the space a line break makes between inline siblings (`#[b a] #[i b]`), attributes in parentheses, text on its element's line with inline elements as `#[tag text]`, `<script>` and `<style>` as their text, an HTML comment as a `//` comment (not rendered), a document's `head` children in a `head` block.
  - What the template cannot hold is listed on stderr as `line N: ...` and left out: an attribute JSX cannot name (`@click`, `:class`), a `lang` on `html` (set it in `kay.config.ts`), the attributes of `body` and a web component's `<slot>` (kept as a comment, as kay's `slot` renders a wrapper's children). HTML that needs an end tag it lacks (an unclosed `<p>` or `<li>`) fails with exit 1.
  - `--format json` prints `{ code, notes }` on one line. It takes no `--check` and one file at most. The docs site has the same conversion in a box ([Migrating from HTML](https://kayjs.kaynooo.fr/migrating/from-html)).
- `kay lint [keslint arguments]...`:
  - Write the types the lint of `.kay` files reads, as `kay check` does, then run the project's `keslint` with the arguments, so linting needs no check before it; its exit code is `keslint`'s (see [Linting](checks.md#linting)).
- `kay test [bun test arguments]...`:
  - Run `bun test` in the project with `--isolate` and `kay/test/preload`, so it needs no `bunfig.toml` and no flag, and report a failure at its `.kay` line; the arguments are `bun test`'s and its exit code is the answer (see [Testing](testing.md)).
- `kay types [dir] [--format text|json] [--quiet]`:
  - Write `.kay/types`, which the language server, `kay lint` and the editor's ESLint read, without checking anything; the editor's ESLint runs it through `bun` the first time it meets a component whose types are missing.
- `kay lsp`, `kay screenshot` and `kay mcp` are in [Language server, screenshot and MCP commands](editor-and-agent-commands.md).

- `kay fmt` refuses a path that is missing or is neither a directory nor a `.kay` file.
- The TextMate grammar the extension highlights `.kay` files with ships as `kay/kay.tmLanguage.json`, for a highlighter such as Shiki: register it as `{ ...grammar, name: 'kay', embeddedLangs: ['typescript'] }`.

### Compile a component from a tool

`kay/compiler` is for a tool that reads `.kay` source outside kay, such as a formatter, a docs checker or a CSS scanner; it exports `compileKay`, `formatDiagnostic` and the types `Diagnostic`, `CompileOptions` and `CompileResult`:

```ts
import { compileKay, formatDiagnostic } from 'kay/compiler'

const source = await Bun.file('src/routes/index.kay').text()
const { diagnostics, classes } = compileKay(source, 'src/routes/index.kay')

for (const diagnostic of diagnostics)
  console.error(formatDiagnostic(source, 'src/routes/index.kay', diagnostic))
```

- `compileKay(source, filename, options?)` returns `{ tsx, map, island?, promote?, why?, classes, diagnostics }` and reports a problem in the source in `diagnostics`. `filename` is read for its base name and, with `root`, its island id: a `_layout.kay`, `_404.kay` or `_error.kay`, like a file with a `--- server` fence, is a route file the server renders, never an island.
- `tsx` is the generated code: TSX for type checking by default, or with `output: 'html'` or `output: 'dom'` the server's or the browser's code that runs. `map` maps it back to the source, `island` is the component's island id when it renders as one, `classes` the `.class` shorthand names a CSS scanner cannot read off the template.
- Options: `root` (island ids are paths relative to it), `includeServer: false` for a browser build, `params` and `paramTypes` typing `ctx.params`, `check: true` for the type-checking output's link, form field and island prop assertions plus the lints, with `lints` setting their levels, `inspect` for `data-kay-src`, and `hydratable`, `twinBuild`, `clientOnly`, `insideIsland` and `importedSignals`, which kay's own build sets.
- A `Diagnostic` is `{ start, end, message, label?, related?, note?, help?, code?, severity?, fixes? }`, `start` and `end` offsets into `source`, `code` a lint's name, `severity` `'warning'` for a lint at the `warn` level.
- `formatDiagnostic(source, filename, diagnostic, paint?)` prints it as `kay check` does, with the file, line and column, the source line and its `help`; `paint` is `(styles, text) => string` for colour, plain text without it.
