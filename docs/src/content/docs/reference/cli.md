---
title: CLI
order: 1
description: The kay commands to scaffold, run, check, build and format a project.
---
Every command takes an optional project directory, the current one by default, and prints its usage for `--help`. An option or argument a command does not take prints that command's usage alone, and names the nearest option for a typo. `kay --help` lists every command.

```sh
bunx -p @kaynooo/kayjs kay new my-app
cd my-app
bun install
bun run dev
```

This needs Bun to know the registry first, see [Installation](/getting-started/installation#registry-setup).

| Command | Does |
| --- | --- |
| `kay new <dir>` | Scaffold a project that checks, builds and runs |
| `kay types [dir]` | Write the types the editor's ESLint reads, without checking |
| `kay add <features> [dir]` | Add `kay new` features, or a kay library, to an existing project |
| `kay dev [dir]` | Run the server, restarting on change, with errors shown in the browser |
| `kay build [dir]` | Check the project and bundle the browser code for production |
| `kay start [dir]` | Serve the last build as production does |
| `kay render <url> [dir]` | Print what the server answers for one URL, without starting it on a port |
| `kay screenshot <path> [dir]` | Shoot a page of the running `kay dev` in a headless Chrome |
| `kay check [dir]` | Type-check the project, `.kay` files included |
| `kay upgrade [dir] [--dry-run] [--quiet]` | Move kay and its libraries to the latest version and rewrite the old forms |
| `kay routes [dir]` | List every route the project serves, and the file serving it |
| `kay not-found [dir]` | List the old URLs visitors hit and found nothing at, and turn one into a redirect |
| `kay doctor [dir]` | Check Bun, versions, config, environment, port and build, and say how to fix each failure |
| `kay env [dir]` | List the environment variables the project, its libraries and kay declare |
| `kay i18n missing [locale] [dir]` | List what each locale lacks against the default one |
| `kay i18n accept <locale> [dir]` | Accept a locale's draft messages |
| `kay explain [lint\|error\|group]` | List the lints and the errors, or a group's, or explain one |
| `kay fmt [paths]` | Format `.kay` files, or with `--stdin` a source on stdin, or with `--from-html` turn HTML into a template |
| `kay lint [args]` | Run ESLint with the types it reads for `.kay` files |
| `kay test [args]` | Run `bun test` with each file isolated and kay's preload loaded |
| `kay migrate astro [dir]` | Translate an Astro project into a kay one |
| `kay migrate content [dir]` | Rewrite the entry files that `migrations` carry over |
| `kay lsp --stdio` | The language server behind the editor extension |
| `kay mcp` | Serve the project to an agent as MCP tools and resources |

## kay new

```sh
kay new my-app --template app --without docker
```

| Option | Effect |
| --- | --- |
| `--template blank\|server\|site\|app` | The preset: one bare static page, an Elysia server (the default), a static site, or a server with kayjs-auth sign-in and a websocket island |
| `--with <features>` | Adds comma-separated [features](#features) to the preset, such as `tailwind,tests` |
| `--without <features>` | Drops features from the preset |
| `--forge forgejo\|github` | Where the repository lives, which decides the CI workflow. `--host` still works until 1.73, with a warning |
| `--runner <label>` | The runner label the CI jobs run on: `debian` on Forgejo and `ubuntu-latest` on GitHub by default |
| `--kay <dependency>` | The `kay` dependency the project installs, such as a path to a packed copy. By default the minor of the kay running the command |
| `-y` | Takes the `server` preset without asking |
| `--dry-run` | Lists the files it would write, and writes none |
| `--format text\|json` | `json` prints one document with the directory, the features and the files |
| `--quiet` | Prints the summary line only |

In a terminal with none of these options, `kay new` asks for a preset, then for each feature.

Without `--forge`, `kay new` reads the `origin` remote. A remote on github.com gets a GitHub Actions workflow in `.github/workflows`. Any other remote, or none, gets a Forgejo workflow in `.forgejo/workflows`.

The workflow can read the repository and nothing more, except a Pages workflow, which gets the permission it publishes with. Each action it uses is pinned to the commit of a release, with the version in a comment.

Every project gets an `AGENTS.md` for coding agents. It points them at kay's docs for the installed version and names the checks the project's scripts run. It also tells them to set `seo.name` to the real name of the site: every page title ends with it, and `kay new` fills it in from the folder name.

### Features

| Feature | Adds | In the presets |
| --- | --- | --- |
| `server` | An Elysia server, run in production as one executable; without it, a static site built to `dist` | server, app |
| `starter` | A header, a skip link, a 404 page, and a home page greeting from the server with a counter island | server, site, app |
| `tailwind` | Tailwind over the Catppuccin Mocha palette; without it, the markup carries no classes | server, site, app |
| `accents` | An accent picker in the header, kept in a cookie; needs `starter` and `tailwind` | server, site, app |
| `eslint` | ESLint through `@kaynooo/eslint`, `.kay` fences and template expressions included | server, site, app |
| `tests` | `kay test` through `kay/test`, with a first test | server, site, app |
| `ci` | A Forgejo or GitHub workflow checking, linting and testing the server, or publishing the static site to Pages | server, site, app |
| `docker` | A `Dockerfile` and `compose.prod.yaml` running the executable, or nginx serving the static site as an unprivileged user on port 8080 | server, site, app |
| `auth` | kayjs-auth, as `kay add auth` writes it: sign-in, register and account pages behind a guard on every page, its users in a SQLite file; needs `server` and `tailwind` | app |
| `postgres` | kayjs-auth's users in Postgres instead of SQLite, with a compose stack for development; run `bun run db:generate init` for the first migration; `kay add` plans kayjs-auth too | none |
| `ws` | An API module over a websocket, with an island counting the visitors online; needs `server` | app |

`blank` has none of them. In the terminal, checking a feature checks what it needs. With options, a feature missing what it needs is refused with the flag to add:

```text
kay: accents needs tailwind: add --with tailwind, or drop it with --without accents
```

## kay add

```sh
kay add tailwind,accents
kay add auth
kay add mail
kay add ai
kay add ui
```

`kay add` gives an existing project the files and edits `kay new --with` would have written, then runs `bun install`. A feature that needs another is refused with the command that adds both, such as `kay add server,ws`. `ai`, `mail`, `cms`, `ui` and `auth` install kay's libraries and list their extension in `kay.config.ts`; `kay add auth` is kayjs-auth, with its `src/auth.ts`, a root guard, a session secret and kayjs-ui's `ui()`.

Before it writes anything, it checks that each file it changes is still what `kay new` wrote. A file you changed stops it with `kay add: nothing was written` and the lines to add by hand. A file you deleted is not written back.

`ai`, `mail` and `cms` add the libraries `@kaynooo/kayjs-ai`, `@kaynooo/kayjs-mail` and `@kaynooo/kayjs-cms`, and list them in the `extensions` of `kay.config.ts`. That config has to be a plain `defineConfig({ ... })`. The import is written where your lint sorts imports, so a file with sorted imports passes `kay lint` with no `lint:fix` after.

| Option | Effect |
| --- | --- |
| `--no-install` | Writes the files without running `bun install` |
| `--dry-run` | Lists the files it would write and writes none. A library has to be installed already for its files to be listed |
| `--format text\|json` | `json` prints one document: the features, the files, whether it installed, and the notes |
| `--quiet` | Prints the summary line only |

## kay types

`kay types [dir]` writes `.kay/types`, which the language server, `kay lint` and the editor's ESLint read, and checks nothing. You rarely run it. The editor's ESLint runs it the first time it lints a component with no types yet.

## kay dev

```sh
kay dev --port 4000 --open
```

`kay dev` runs `src/server.ts` with `NODE_ENV=development`. An edit to a template, island, loader or API route reloads in the same process. A change it cannot reload that way, such as the config or the entry, starts a new process. A start uses the browser build an earlier run left when nothing it read has changed since. So a second `kay dev` of a project that did not change builds nothing.

Editing the scripts or version in `package.json` restarts nothing, unless a module of yours imports the file. A `kay.config.ts` edit starts the new server without waiting for the editor types.

A change to a file at the project root, such as `.env` or a `package.json` field Bun resolves, starts a new process too, which reads the new values. The server also restarts on its own after 200 reloads, or once it has grown by 64 MiB, since Bun keeps the code of every module it evaluates again. Set `KAY_DEV_RELOAD_GROWTH_MB` to change that number of MiB.

A `.env` value built from another, such as `URL=${HOST}/x`, follows the file as well. The process that loads `kay.config.ts` for the editor types sees the new values too.

These changes reload nothing: tests (a root `tests/`, `test/`, `e2e/` or a name joining them such as `tests-e2e/`, `__tests__/`, `*.test.*`, `*.spec.*` and `*.e2e.*` files anywhere, and a root Playwright, Vitest, Jest or Cypress config), root files no server reads such as a README or a LICENSE, and the backup and temporary files an editor writes beside a source. A save that touches `.css` files alone restarts nothing and swaps the stylesheets in the open pages.

A page whose server stopped tries to reconnect at once, then less often: four times a second for the first ten seconds, then every five seconds, so a tab left open on a stopped server stays quiet. A hidden tab waits until you show it.

Open pages refresh by themselves, an edited island is swapped in place, and a project that fails to compile shows its errors in the browser. Every page carries the [dev tool and inspector](/guides/performance).

| Option | Effect |
| --- | --- |
| `--entry <file>` | The server entry, when `entry` in `kay.config.ts` does not name it |
| `--port <port>` | Sets `PORT` for the server, over the shell's and the `.env`'s |
| `--host[=<address>]` | Listens past this machine: on `0.0.0.0`, or on the address given. Needed in a container publishing its port |
| `--inspect[=<address>]` | Opens Bun's debugger in the server, at `ws://localhost:6499/kay` by default, the same address after every restart |
| `--open` | Opens the address in the browser once the server is ready |
| `--quiet` | Leaves out the line per restart and stylesheet swap |
| `--no-types` | Does not type-check the project beside the server |
| `--format text\|json` | `json` prints each line as one JSON object on stdout, with an `event` field |

The server starts as soon as the config is read. The editor types in `.kay/types` are written once it listens, or after three seconds if it does not, so the first page does not wait for them.

`kay dev` type-checks the project as [`kay check`](#kay-check) does, in a process of its own beside the server, so a reload never waits for it.

It runs after the first start and after each change that can alter a type, a moment after the last save. The errors show at their `.kay` line in the dev tool's Problems tab, which updates without a reload, in [`.kay/dev/errors.json`](#errors-without-a-browser) as `type` errors, and in the terminal, which also says when they are fixed. A project with no `tsconfig.json` is not checked, and `--no-types` turns the check off.

The terminal shows the address once, then one line per change, with how long it took.

```text
kay dev: http://localhost:3000 (ready in 412 ms)
14:02:31 src/routes/index.kay: reloaded in 58 ms
14:02:40 src/server.ts: restarted in 412 ms
```

When another process holds the port, the server moves to the next free one and the ready line says so. A port given with `--port`, or by `PORT` in the environment or `.env`, is never moved: the server fails to start and names it.

```text
kay dev: http://localhost:4001 (ready in 412 ms, 4000 was in use)
```

A server listens on `localhost` only, so a phone on your network cannot reach it. `--host` opens it. When it listens on every address, a second line gives the address of this machine on your network.

```text
kay dev: http://localhost:3000 (ready in 412 ms)
kay dev: http://192.168.1.20:3000 on the network
```

`--inspect` opens Bun's debugger at the same address after every restart, so a debugger reconnects by itself. `kay dev` listens there and passes each connection to the server that is running. The address is printed once, under the ready line, with a link to `debug.bun.sh`. A connection stays open across a reload and closes when the server restarts in a new process.

An address another process holds stops `kay dev`. One past this machine is refused unless `--host` is given too.

In a terminal, `o` opens the address, `r` restarts the server, `c` clears the screen and `q` or Ctrl+C quits. Piped, or under `--format json`, no key is read.

The dev server answers 421 to a request whose `Host` is not `localhost`, a `*.localhost` name, an IP address or the site's host. Put any other name, such as a tunnel's, in `KAY_DEV_HOSTS`, comma-separated and without ports.

```sh
KAY_DEV_HOSTS=dev.example.com bunx kay dev --host
```

### Events for tools

Under `--format json`, each line is one JSON object on stdout with an `event` and a `time`. The server's own output goes to stderr.

```json
{"event":"ready","time":"2026-10-14T14:02:30.000Z","url":"http://localhost:3000","ms":412}
{"event":"restart","time":"2026-10-14T14:02:40.000Z","changed":["src/server.ts"],"ms":412}
```

| Event | Fields |
| --- | --- |
| `ready` | `url`, `ms`, `inUse` when the port moved, `network` under `--host` |
| `restart` | `changed` (the files), `ms`, `url`, and `reloaded: true` for a reload in the same process |
| `styles` | `changed`, `ms`, for a stylesheet swap |
| `exit` | `code`, when the server exits on its own |
| `debugger` | `url`, under `--inspect` |
| `no-browser` | `command`, when `--open` found no browser |
| `builder-exit` | The process building the client exited, and each change starts it again |
| `types` | `errors`: the type errors the check found, each with `file`, `line`, `column`, `code` and `message`, empty once there are none |
| `error` | An error from [`.kay/dev/errors.json`](#errors-without-a-browser), with its fields |

`--quiet` leaves out the `restart` and `styles` events as it leaves out their lines.

<ReadMore href="/llms/dev-server">What `kay dev` closes after an edit, how islands swap in place and the keys in a terminal.</ReadMore>

<ReadMore href="/llms/dev-tool">The dev tool's tabs.</ReadMore>

### Errors without a browser

`.kay/dev/errors.json` lists the errors the dev server met, for a reader that never opens the browser, such as a coding agent running `kay dev` in the background.

While it runs, `kay dev` also writes its address to `.kay/dev/server-<pid>.json`, for [`kay screenshot`](#kay-screenshot) and the `screenshot` tool.

```json
{
  "errors": [
    {
      "kind": "request",
      "time": "2026-10-14T14:02:31.000Z",
      "request": { "method": "GET", "path": "/blog" },
      "message": "posts is not iterable",
      "report": "TypeError: posts is not iterable\n    at load (/app/src/routes/blog.kay:12:5)",
      "at": { "file": "src/routes/blog.kay", "line": 12, "column": 5, "frame": "11 | ul\n12 |   for post of posts\n   |     ^" }
    }
  ]
}
```

`kind` says where the error came from.

| Kind | Meaning |
| --- | --- |
| `compile` | The project failed to compile. `problems` holds each position |
| `boot` | The server failed to start |
| `request` | A request threw |
| `browser` | An island met an error, under its page's path |
| `type` | A type error the check beside `kay dev` found, one entry each at its `.kay` line, replaced whenever the check ends |

A request's errors stay across restarts, the latest 50 kept. A server not run by `kay dev` writes none.

### Inspector

Under `kay dev`, hold Alt over an element to see the `.kay` file and line that wrote it, and Alt+click to open it in your editor. `KAY_EDITOR` picks the editor. The [inspector guide](/guides/performance#the-inspector) has the details.

## kay build

```sh
kay build                             # into .kay/client
kay build --compile ./server          # one executable
kay build --static --outdir dist      # static files for a host with no server
```

The build runs `kay check` first and keeps the last build when the check or the build fails. It builds for production whatever `NODE_ENV` the shell holds.

| Option | Effect |
| --- | --- |
| `--compile <file>` | Also bundles the server and everything it serves into one executable |
| `--verify` | With `--compile`, starts the executable and runs its health check, failing the build with the server's output |
| `--verify-load` | With `--compile`, only loads the modules of the executable, with no database or secret, for a container build stage; not with `--verify` |
| `--entry <file>` | The server entry to compile, and to type the check against |
| `--static` | Also writes the whole site as static files, see [Static export](/guides/static-export); not with `--compile` |
| `--outdir <dir>` | Where `--static` writes, `dist` by default; only with `--static` |
| `--no-check` | Skips the check |
| (outputs) | A build first removes the executable the last `--compile` wrote and the folder the last `--static` wrote, as Tailwind scans every file of the project and a leftover output would be read as a source |
| `--no-cache` | Empties `.kay/cache` first, so everything is compiled, encoded and fetched again; the chunks kept for open tabs stay |
| `--analyze` | Lists the modules weighing most in the entry and each island, see [Performance](/guides/performance#find-the-heavy-modules) |
| `--deny-warnings` | Fails the build on a warning of the check or of a lint too, such as `over-budget` |
| `-p <tsconfig>` | Names another tsconfig for the check; not with `--no-check` |
| `--format text\|github\|json` | `github` annotates problems on the diff, `json` prints the whole build as one document, see [Output for tools](#output-for-tools) |
| `--quiet` | Leaves out the size report |

The build prints what a page with islands loads, then a table per route with its sizes. [What a page weighs](/guides/performance#what-a-page-weighs) explains the report and `budget` limits it.

Every build writes `/_kay/THIRD-PARTY-LICENSES.txt`, with the licence of each package and icon set the browser gets. An executable prints the same notices, plus its server's packages and Bun's own notice, for `./server --licenses`. Bun links JavaScriptCore and WebCore under the LGPL-2, so the notice points to their source and says how to build with a modified copy. An icon set under the MIT licence that ships no licence text gets the standard text, under its author's name.

See [Prove the executable starts](/guides/deployment#prove-the-executable-starts) for `--verify` and `--verify-load`.

<ReadMore href="/llms/build-and-start">Progress output, how a route's scripts are estimated, the notices for icon sets and codecs, and the build document in full.</ReadMore>

## kay start

```sh
kay start              # the last build, as the deployed server runs it
kay start --port 8080
```

`kay start` serves the last `kay build` with `NODE_ENV=production`. That is the executable `--compile` wrote when there is one, else the server entry. It refuses to start without a build, and warns when a source changed since.

It reads `.env.production` and `.env` as Bun does under `NODE_ENV=production`. A variable the shell sets wins over both.

| Option | Effect |
| --- | --- |
| `--entry <file>` | Runs that server entry instead, relative to the current directory |
| `--port <port>` | The port to listen on: `--port`, else the shell's `PORT`, else the env files', else 3000 |

Ctrl-C, `SIGTERM` and `SIGHUP` reach the server once, and `kay start` waits for it to drain and exit. A second Ctrl-C stops it at once. `kay start` exits with the server's code.

## kay render

```sh
kay render /about                     # the page's HTML on stdout
kay render /account --cookie kay_session=…
kay render /_kay/action/src/routes/index.kay/add --body 'title=Milk' -i
```

`kay render` answers one request as the server entry does under `kay dev`, and prints the body on stdout. A script or an agent sees what a page renders without starting a server.

The server runs on a Unix socket of its own, so it runs beside a `kay dev` holding the port. The whole app boots, so its jobs run, and a `POST` to an action runs against the app's database.

A redirect prints `kay render: 302 Found, to /login` on stderr and exits 0. A status of 400 or above prints its line on stderr, the body still on stdout, and exits 1.

| Option | Effect |
| --- | --- |
| `--method <method>` | The request's method, `GET` by default, `POST` with `--body` |
| `--body <text>` | The request's body, sent as a form posts it |
| `--header <name: value>` | A request header; repeat it for more |
| `--cookie <name=value>` | A cookie; repeat it for more. Copy a session cookie from the browser to render a guarded page |
| `-i`, `--include` | Prints the status line and the response's headers on stderr |
| `--entry <file>` | Runs that server entry instead, relative to the current directory |

<ReadMore href="/llms/check-and-tools">Full URLs and hosts, `base`, the timeouts and how the temporary build is cleaned up.</ReadMore>

## kay screenshot

```sh
kay screenshot /admin/posts            # 375 and 1280 px wide
kay screenshot /admin/posts --width 375 --scheme dark
kay screenshot /admin/posts --full-page
kay screenshot /account --cookie kay_session=abc123
```

`kay screenshot` opens a page of the project's running `kay dev` in a headless Chrome or Chromium and writes a PNG under `.kay/screenshots/`. It shows what the HTML does not: a control off screen at phone width, a table that stacks badly, the dark scheme. Chrome comes from `BUN_CHROME_PATH`, else the first one on the `PATH`.

Start `kay dev` first. It writes its address to `.kay/dev/server-<pid>.json`, and the command refuses to run when no `kay dev` of the project is alive. The path is the one a visitor types, a locale prefix included. A site with a `base` gets it added when the path lacks it, and the page is opened as a proxy in front of the site would serve it. A path that names another host, or that climbs out with `..`, is refused before any browser starts.

The two latest shots of each page, width and scheme stay next to each other, and the command prints how many pixels changed since the one before, with a diff image beside them where the changed pixels are red. Shoot, edit, shoot again to check an edit moved only what it meant to. Older shots go once the folder holds a few hundred files. A shot too large to compare with the last, over 12 million pixels, is kept without a diff.

The page's console errors and the errors `kay dev` listed for it come back with the shots. A redirect is followed. No cookie is sent unless you give one with `--cookie`, so a page behind a sign-in shows the sign-in until you pass its session. A cookie is an argument, so `ps` lists it while the command runs: pass the session of a development database, not a real one. A page that does not finish loading within 10 seconds is shot as it stands, with the reason among the console errors.

| Option | Effect |
| --- | --- |
| `--width <px>` | The window's width, 200 to 3840; repeat it for more. 375 and 1280 by default |
| `--height <px>` | The window's height, 200 to 8000. 800 by default |
| `--scheme light\|dark` | The colour scheme the page is asked for. `light` by default |
| `--full-page` | The whole page instead of the window, cut at 8000 px |
| `--cookie <name=value>` | A cookie the page is opened with, to shoot a page behind a session; repeat it for more |
| `--format text\|json` | `json` prints the url, status, shots, console errors and the dev server's problems as one document |

## kay check

```sh
kay check --deny-warnings --fix
kay check src/routes/blog src/lib/feed.ts   # only the problems in those
kay check --watch
```

The first path is the project when it is a directory holding a `kay.config.ts`, a `package.json` or a `tsconfig.json`. The other paths narrow the report, and `--fix`, to those files and directories. The project is still type-checked as a whole.

The type check is Bun's own (`bun check`), on every core, and runs even when your `package.json` has a `check` script. When nothing the last clean check read has changed, the next one skips it. A file written within a second before a check counts as changed.

| Option | Effect |
| --- | --- |
| `--deny-warnings` | Fails on warnings too, not only on errors |
| `--watch` | Checks again on every change to the project, a change to `.kay` files alone without a new process |
| `--fix` | Applies the fixes that change nothing else, then reports what is left. With `env` in `kay.config.ts` it also declares raw `process.env` reads |
| `--dry-run` | Counts the fixes `--fix` would apply and writes nothing |
| `--only <group>` | Reports one group's lints alone, such as `seo`, as an audit |
| `--since <minor>` | Reports, and with `--fix` fixes, the `deprecated` lints that came in that minor, such as `1.46` |
| `--format text\|github\|json` | `github` prints each problem as a workflow command, `json` as one document on stdout |
| `-p <tsconfig>` | Names another tsconfig, relative to the directory |
| `--entry <file>` | The server entry whose `app` types `ctx.locals`, `src/server.ts` by default |

`--since` does not go with `--only`. The exit code is the same in every format.

### Your own checks

List checks in `kay.config.ts` and `kay check` runs them with its own. Their problems show in the text report, in `--format json` and `github`, and in the MCP `check` tool, and they count toward the exit code and `--deny-warnings`.

```ts
export default defineConfig({
  checks: [
    async ({ root, report }) => {
      if (!(await Bun.file(`${root}/compose.prod.yaml`).exists()))
        report({ level: 'error', message: 'compose.prod.yaml is missing', file: 'compose.prod.yaml' })
    },
  ],
})
```

A check gets the project's `root`, a `routes()` function that lists the routes the project serves, and `report`. `level` is `'error'` unless you give `'warning'`. `file` is relative to the project and defaults to `kay.config.ts`, and `line` and `column` default to 1.

A check that throws is reported as an error, and the other checks still run. So is one that has not finished after 30 seconds. `--only` and `--since` leave your checks out. `kay check` and its lints have their [own page](/reference/checks).

## kay upgrade

```sh
kay upgrade
kay upgrade ../my-site
kay upgrade --dry-run
```

`kay upgrade` moves `kay` and every `@kaynooo/kayjs-*` library in `package.json` to the latest version, then installs. A range pointing at a path, a workspace or a git source is left as it is.

It then runs the kay it installed. Each minor you skipped may have replaced a form with a new one, and each is a lint in the `deprecated` group with a fix. The oldest minor's fixes run first.

A last `kay check --fix` applies any other quick fix and prints what is left for you to change by hand. An app already on the latest version is left alone. If the install fails, `package.json` goes back as it was.

`--dry-run` lists the packages it would move and changes nothing: no write, no install, no rewrite. `--quiet` leaves out the step lines, keeping the packages it would move and how it ended. The old forms it would then fix are known only to the new version, so they are not listed.

What a minor breaks that `kay check` cannot see is in [Upgrading](/guides/upgrading).

## kay doctor

```sh
kay doctor
kay doctor --port 4000
```

`kay doctor` checks what keeps a project from running and prints one line per check, with the fix under each that fails. It exits 1 when any fails, and runs every check either way.

| Check | Fails when |
| --- | --- |
| `bun` | Bun is older than kay needs |
| `versions` | `@kaynooo/kayjs` or a `@kaynooo/kayjs-*` library listed in `package.json` is not installed, or a library is not on kay's minor |
| `config` | `kay.config.ts` does not load |
| `env` | A variable the project declares as required is set neither in the shell nor in the project's `.env` files. `kay env` lists them |
| `port` | The port is in use. It is `--port`, else `PORT`, else 3000. The port of this project's own `kay dev` passes. It is tried on `HOST` when set, else on every IPv4 address and on both loopback addresses (IPv4 and IPv6), and `0` passes as a port the system picks |
| `build` | `.kay/client` or `.kay/dev` was built by another kay, which `kay build` or a restart of `kay dev` fixes |

`--format json` prints `{ checks }`, each with its `name`, `ok`, `message` and, on a failure, its `fix`.

## kay env

```sh
kay env
```

`kay env` lists the environment variables the project declares, without running the server entry. Each has its source, its type, whether it is required (`always`, `production` or `optional`) and its default.

It reads the `defineEnv` schemas in the modules under `src`, `publicEnv`, each library in `extensions`, and kay's own `PORT`, `HOST`, `SITE_URL`, `KAY_SECRET` and the deprecated `ORIGIN`. A module that does not load is named as not read. See [Environment variables](/essentials/data-loading#environment-variables).

The modules under `src` are imported, so their top-level code runs.

### Write the example file

```sh
kay env --write
```

This appends to `.env.example` every declared variable it does not mention, with its description, the libraries' and kay's included. A required variable is written as `NAME=`, an optional one commented out beside its default. What the file holds is kept, and it is created when missing. `--example <file>` writes another file.

### Compare with the compose and example files

```sh
kay env --compose compose.prod.yaml --example .env.example
```

This checks your deploy files against what the project declares. It reports an error when:

- a variable production needs is set by no service of the compose file, in `environment` or in an `env_file`
- a variable production needs is missing from the example file, unless a compose service gives it a value
- the example file lists a variable that no schema declares, no service sets and the compose file never reads as `${VAR}`

A `process.env.X` or `Bun.env.X` read in `src` that nothing declares is a warning. `NODE_ENV` and test files are left out.

`kay check --fix` declares those variables for you. It adds them to your `defineEnv` schema, or writes `src/env.ts` when you have none, turns a `?? 'default'` into the variable's `default`, and rewrites each read to `env.X` with the import.

A variable is left with its warning when a read assigns it, destructures it, sits in a `.kay` file or in a file that already has an `env`. Two things change. An empty value now takes the default, as `defineEnv` treats it as unset. And the files you read from now import the schema, which reads and checks the environment as it loads. `kay upgrade` does not do this.

`--compose` can be given several times. The files are read relative to the project, and any `--compose` or `--example` replaces the `env` in `kay.config.ts` entirely. With neither, kay compares the production compose files at the project root (`compose*.yaml` and `docker-compose*.yaml`, leaving out a name with `dev`, `development`, `test`, `local` or `override` in it) and `.env.example`, those that exist. Set `env: false` in `kay.config.ts` to compare nothing.

A module under `src` that does not load is reported, and nothing is then called undeclared. A variable set to an empty string counts as not set.

Raw reads are found in one-line forms only: `process.env.X`, `process.env['X']`, `Bun.env.X` and `const { X } = process.env`. The command exits with 1 on an error, and `--format json` adds the problems as `findings`.

`kay check` runs the same comparison. To choose the files, name them in `kay.config.ts`.

```ts
export default {
  env: { compose: 'compose.prod.yaml', example: '.env.example' },
}
```

## kay i18n

```sh
kay i18n missing
kay i18n accept fr
```

`kay i18n missing` lists what each locale lacks against the default one. It names the message keys missing from a locale, a library's included, and the entries a localized collection has in the default locale but not in that one. `kay i18n missing fr` shows one locale. `--format json` prints the same as one line of JSON.

A message whose line ends on `// draft` is a draft, written by a machine and waiting for a person. The comment goes on the message's own line: on a group's opening brace it marks nothing. `kay check` warns of each one. `kay i18n accept fr` deletes every draft comment in `src/messages/fr.ts` once you have checked them.

`kay i18n translate fr` comes from the kayjs-ai library. It fills what `fr` lacks with a model and saves it as drafts. See [kayjs-ai](/libraries/kayjs-ai#translate-what-is-missing).

A library can add commands of its own. `kay i18n` alone lists every `i18n` command, and `kay --help` lists each library's under its name.

## kay not-found

```sh
kay not-found
kay not-found --redirect /old-page
kay not-found --redirect /old-page --to /new-page
kay not-found --redirect /old-page --runtime
```

Lists the paths visitors asked for and found nothing at, most hit first, with the hosts they came from and a suggested target. It reads `data/not-found.sqlite`, which the production server writes, or the file `--file` names. A path a `redirects` entry answers already is left out.

`--redirect` adds the path to `redirects` in `kay.config.ts`, going to `--to` or to the suggestion, and removes it from the list. When `kay.config.ts` has no object to add it to, kay prints the line to add by hand.

`--runtime` writes it to `data/not-found.sqlite` instead, which the running site reads, so the redirect answers with no deploy and `kay.config.ts` stays as it is. It goes only to a page of the site unless `runtimeRedirects.hosts` lists the host. See [Redirects](/essentials/routing#redirects).

## kay routes

```sh
kay routes
```

```text
GET   /admin/report               page      src/routes/admin/report.kay, prerendered
      layouts src/routes/_layout.kay > src/routes/admin/_layout.kay
      guards  src/routes/admin/_guard.ts
POST  /_kay/action/src/routes/index.kay/add  action  src/routes/index.kay add
GET   /api/items                  api       src/api/items.ts
GET   /old                        redirect  308 to /
GET   /_kay/health                kay       health check
```

`kay routes` lists the routes the project serves in production, without starting the server. Each page shows its layouts and guards, once per locale's path.

It also lists actions, endpoints, API routes, redirects, feeds and the routes kay serves itself, such as `/_kay/health`. A page marked `prerendered` is built by `kay build`. A route that sets `guards: false` is marked `open`.

API modules are the one thing it runs, as their routes are only known once they are built. What they print goes to stderr.

## kay lint, test, fmt and explain

```sh
kay explain positional-key   # one lint, with an example and the fix
kay explain --format json    # every lint, for a tool to read
kay fmt src                  # format a folder
kay fmt --check              # list unformatted files and fail
kay fmt --from-html card.html   # print HTML as a .kay template
kay lint --fix --cache       # ESLint, with the types it reads written first
```

`kay lint` writes the types ESLint reads for `.kay` files, then runs the project's `keslint` with the arguments you give it. The `lint` script of a new project is `kay lint --cache`.

`kay test` runs `bun test` with every file in modules of its own and `kay/test/preload` loaded, and passes its arguments on, so `kay test --watch` and `kay test tests/cart.test.ts` work. A project needs no `bunfig.toml` for it. A failure is reported at the line of the `.kay` file. The `test` script of a new project is `kay test`.

`kay fmt` keeps the `.class` shorthand while a line fits in 120 characters. When an element's classes make its line longer, it writes them as a `class` attribute inside the parentheses, over several lines when the list is long, so a long Tailwind list reads as a block.

In an app whose stylesheet imports Tailwind, `kay fmt` also puts the shorthand's classes in Tailwind's order, the one the Tailwind rules of `@kaynooo/eslint` use, and keeps a class Tailwind does not know where it stands, first. When it moves the classes into a `class` attribute, the words already in that attribute are sorted with them as one list. The editor's format does the same.

To know Tailwind's order, `kay fmt` loads the app's `tailwindcss` and runs the plugin and config modules the stylesheet names, as the build does. It fetches nothing: before `bun install`, or with a package missing, the classes stay as written. The editor picks up an edit to any stylesheet the entry imports on its next format. A line that is long for its other attributes, not its classes, is left as written.

`kay fmt --stdin [path]` reads a source on stdin and prints it formatted, for an editor's formatter: see [Other editors](/guides/other-editors). `path` names the file it is for, and a source that does not compile prints its problems on stderr and nothing on stdout.

`kay fmt --from-html` reads a file, or stdin, and prints the HTML as a template, with what it could not carry over listed on stderr. [Migrating from HTML](/migrating/from-html) shows what it writes.

`kay explain` and `kay fmt` take `--format json` too, see [Output for tools](#output-for-tools).

## kay migrate

```sh
kay migrate astro . --outdir ../kay-site
```

`kay migrate` translates an Astro project's `.astro` files into `.kay` ones, its pages into `src/routes` and its content config into kay's. It lists what is left to do by hand at its line in the Astro file. It never writes over a file that exists.

| Option | Effect |
| --- | --- |
| `[dir]` | The Astro project, the current directory by default |
| `--outdir <dir>` | Writes there instead of next to the `.astro` files. A directory with no `package.json` gets a whole kay project. `--out` is the older spelling and still works until 1.73, with a warning |
| `--dry-run` | Lists what it would write, and writes none |

The [Astro guide](/migrating/from-astro) shows what it translates and how to finish what it lists.

```sh
kay migrate content
```

`kay migrate content` rewrites the entry files of the folder collections that declare [`migrations`](/guides/content#when-the-schema-changes), for each entry a step carried to the shape the schema accepts. A file keeps its format: a JSON file its indentation, a Markdown file its body as it was written. A YAML file loses its comments, except a `# draft` mark. An entry the schema already accepts is not touched.

The command lists each file it rewrote, and a file it could not read, which makes it exit with 1. Collections a loader fills write their entries back through the loader when they are read, so the command leaves them alone.

| Option | Effect |
| --- | --- |
| `[dir]` | The project, the current directory by default |
| `--format json` | Prints the rewritten and failed files as one JSON document |

## kay mcp

```sh
claude mcp add kay -- bunx kay mcp
```

`kay mcp` serves the project to an agent as an [MCP](https://modelcontextprotocol.io) server over stdio. The agent calls kay's commands as typed tools instead of running them in a shell. Nothing is set up in the app.

Another client takes the same command in its MCP config, such as `.mcp.json` at the project's root.

```json
{ "mcpServers": { "kay": { "command": "bunx", "args": ["kay", "mcp"] } } }
```

| Tool | Does |
| --- | --- |
| `check` | `kay check --format json`. `paths` narrows the report, `only` picks a group, `denyWarnings` counts warnings as failures |
| `routes` | `kay routes --format json` |
| `explain` | The lints and error codes, or with `name` one lint, error code or group |
| `render` | `kay render` on `url`, with `method`, `body`, `headers` and `cookies` |
| `screenshot` | `kay screenshot` on `path`, with `width`, `height`, `scheme`, `fullPage` and `cookies` (as `name=value`). Answers the document, then an image per shot; `diff: true` adds the diff image against the shot before |
| `doctor` | `kay doctor --format json`. `port` is the port to check |
| `dev_errors` | The errors a running `kay dev` met, from [`.kay/dev/errors.json`](#errors-without-a-browser) |

The resources are `kay://llms.txt`, the index to start from, and one `kay://llms/<file>.md` for each guide of kay's `llms/`.

Each tool runs its command in a child process, so a call costs what the command does. Calls run one at a time, in the order they came.

## Quiet and plain output

`kay add`, `kay build`, `kay check`, `kay dev`, `kay fmt`, `kay migrate`, `kay new`, `kay render`, `kay routes`, `kay start`, `kay types` and `kay upgrade` take `--quiet`; every other command refuses it.

`--quiet` prints the problems and one summary line, without the size report or the files one by one. `kay types` prints nothing at all.

`kay start` leaves out its warnings about a stale build, `kay render` its status line and `kay routes` the note about the routes the server adds when it starts.

`--dry-run` lists what the command would write and writes nothing. `kay check --dry-run` counts the fixes `--fix` would apply, `kay fmt --dry-run` lists the files it would format and exits 0, and so do `kay new`, `kay add`, `kay migrate`, `kay i18n accept`, `kay not-found --redirect` and `kay upgrade`.

`kay fmt` refuses `--check` and `--dry-run` together. `kay fmt --check` stays the verify-only form: it fails when a file is not formatted.

`kay types`, `kay build` and `kay dev` write only generated output under `.kay` and `dist`, never a file of yours, so they take none.

`kay add`, `kay new` and `kay types` also take `--format json`.

```sh
kay fmt src --quiet   # formatted 3 files
```

Colour only goes to a terminal, and not under `NO_COLOR` or `TERM=dumb`. `FORCE_COLOR` brings it back to a pipe, as a CI log showing colour wants.

## Output for tools

`kay add`, `kay new`, `kay types`, `kay build`, `kay routes`, `kay env`, `kay doctor`, `kay i18n missing`, `kay explain`, `kay fmt`, `kay migrate`, `kay not-found` and `kay screenshot` take `--format json`, as `kay check` does. Stdout then holds one JSON document on one line, and what the app's own code prints goes to stderr. The exit code is the one the text output gives.

| Command | Document |
| --- | --- |
| `kay build` | `{ errors, warnings, problems }`, then `failed`, `built`, `exported` and `compiled` as the build ran, see [The build document](#the-build-document) |
| `kay not-found` | `{ missing }`, each with its `path`, `hits`, `referrers`, `target` and `reason` |
| `kay routes` | `{ routes, unlisted }`, each route with its `methods`, `path`, `kind` and `file` |
| `kay i18n missing` | `{ locales }`, each locale with its missing `messages` keys and its missing `entries` by collection |
| `kay doctor` | `{ checks }`, each with its `name`, `ok`, `message` and `fix` |
| `kay env` | `{ variables, unread }` (and `findings` when it compares files), each variable with its `name`, `source`, `type`, `required` and `default` |
| `kay explain` | `{ groups, lints, errorGroups, errors }`, or for one lint its `summary` and its `wrong` and `right` examples |
| `kay fmt` | `{ errors, warnings, problems, written, changed }` |
| `kay migrate astro` | `{ dryRun, written, kept, copied, notes }` |
| `kay migrate content` | `{ rewritten, failed, dryRun }` |
| `kay add` | `{ features, written, installed, notes, dryRun }` |
| `kay new` | `{ dir, features, files, dryRun }` |
| `kay types` | `{ files, dir }` |

A command that cannot run, such as on a directory that does not exist, prints `{ errors: 1, warnings: 0, problems: [{ severity, code: null, message }] }`. Paths are relative to the current directory.

### The build document

`kay build --format json` adds a key for each stage that ran.

| Key | Holds |
| --- | --- |
| `failed` | `{ stage }`, when a stage stopped the build |
| `built` | `islands`, `stylesheets`, `prerendered`, `entries`, `ms`, `sizes`, `routes`, `stages` and `caches` |
| `exported` | `{ pages, files, dir, ms }`, under `--static` |
| `compiled` | `{ executable, ms }`, under `--compile` |

`sizes` has the `raw` and `gzip` bytes of the entry and of each island, with `modules` under `--analyze`. Each island says `why` it is one.

`routes` has each route's `js` and `css` gzip bytes and the `islands` its pages render. It also has `pages` prerendered and `kept`, the pages the build kept on its own. For a route rendered per request it gives the `stop` that decided so, and `estimated` when its scripts are a guess, see [What a page weighs](/guides/performance#what-a-page-weighs). `stages` is a list of `{ name, ms }`, and `caches` of `{ name, cached, made }`.

Code that ends the process mid-build leaves the problems so far, with one saying it ended and the stage.

<ReadMore href="/llms/project#commands">Every field of the build document, and how a build that ends the process is reported.</ReadMore>
