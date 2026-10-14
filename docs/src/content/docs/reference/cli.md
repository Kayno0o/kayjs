---
title: CLI
order: 1
description: The kay commands to scaffold, run, check, build and format a project.
---
`kay dev`, `kay build`, `kay check`, `kay start` and `kay routes` take an optional project directory (the current one by default), and every command prints its usage for `--help`.

Once Bun knows the registry ([Installation](/getting-started/installation#registry-setup)):

```sh
bunx -p @kaynooo/kayjs kay new my-app
cd my-app
bun install
bun run dev
```

| Command | Does |
| --- | --- |
| `kay new <dir>` | Scaffold a project that checks, builds and runs |
| `kay dev [dir]` | Run the server, restarting on change, with errors shown in the browser |
| `kay build [dir]` | Check the project and bundle the browser code for production |
| `kay start [dir]` | Serve the last build as production does |
| `kay render <url> [dir]` | Print what the server answers for one URL, without starting it on a port |
| `kay check [dir]` | Type-check the project, `.kay` files included |
| `kay routes [dir]` | List every route the project serves, and the file serving it |
| `kay explain [lint\|group]` | List the lints, or a group's, or explain one |
| `kay fmt [paths]` | Format `.kay` files |
| `kay migrate astro [dir]` | Translate an Astro project into a kay one |
| `kay lsp --stdio` | The language server behind the editor extension |

## kay new

```sh
kay new my-app --template app --without docker
```

| Option | Effect |
| --- | --- |
| `--template blank\|server\|site\|app` | The preset: one bare static page, an Elysia server (the default), a static site, or a server with sessions and members in Postgres |
| `--with <features>` | Adds comma-separated [features](#features) to the preset, such as `tailwind,tests` |
| `--without <features>` | Drops features from the preset |
| `-y` | Takes the `server` preset without asking |

In a terminal with none of these options, `kay new` asks for a preset, then for each feature.

Every project gets an `AGENTS.md` for coding agents. It points them at kay's docs for the installed version, `node_modules/kay/llms.txt`, which Claude Code loads at the start of each session through its `@node_modules/kay/llms.txt` line, and names the checks the project's scripts run. A project made before it existed adds it by hand.

### Features

| Feature | Adds | In the presets |
| --- | --- | --- |
| `server` | An Elysia server, run in production as one executable; without it, a static site built to `dist` | server, app |
| `starter` | A header, a skip link, a 404 page, and a home page greeting from the server with a counter island | server, site, app |
| `tailwind` | Tailwind over the Catppuccin Mocha palette; without it, the markup carries no classes | server, site, app |
| `accents` | An accent picker in the header, kept in a cookie; needs `starter` and `tailwind` | server, site, app |
| `eslint` | ESLint through `@kaynooo/eslint`, `.kay` fences included | server, site, app |
| `tests` | `bun test` through `kay/test`, with a first test | server, site, app |
| `ci` | A Forgejo workflow checking, linting and testing the server, or publishing the static site to Pages | server, site, app |
| `docker` | A `Dockerfile` and `compose.prod.yaml` running the executable, or nginx serving the static site | server, site, app |
| `auth` | Sessions, a sign-in, members in Postgres through pg-orm and a guarded `/account`; needs `server` | app |
| `ws` | An API module over a websocket, with an island counting the visitors online; needs `server` | app |

`blank` has none of them. Asked in the terminal, checking a feature checks what it needs, and unchecking one unchecks what needs it. With options, a feature missing what it needs is refused with the flag to add:

```
kay: accents needs tailwind: add --with tailwind, or drop it with --without accents
```

## kay dev

`kay dev` runs `src/server.ts` with `NODE_ENV=development`. Open pages refresh by themselves, an edited island is swapped in place, and a project that fails to compile shows its errors in the browser. What the entry imports before it calls `pages()`, such as a mailer rendering `.kay` mails, imports `.kay` files and icons as pages do.

`kay dev` builds the browser code itself while the server boots, in a process it keeps from one change to the next, and the server reads that build as a production server reads `kay build`'s. An edit builds again only what it reaches: a change to a server module restarts the server alone, a new word in a template builds the Tailwind stylesheets again only when Tailwind makes a class of it, and an edit to stylesheets alone swaps them into the open pages without restarting anything. A `pages()` given options for the browser build that `kay.config.ts` does not hold bundles its own as it boots, and says so: keep those options in `kay.config.ts`.

| Option | Effect |
| --- | --- |
| `--entry <file>` | The server entry, when it is not `src/server.ts` |
| `--port <port>` | Sets `PORT` for the server, over the shell's and the `.env`'s |
| `--host[=<address>]` | Listens past this machine: `0.0.0.0` alone, or the address given, and answers to this machine's own name and `<name>.local` too. Without it, a server naming no `hostname` listens on `localhost` only, so `kay dev` in a container publishing its port needs `--host` |
| `--inspect[=<address>]` | Opens Bun's debugger in the server, at `ws://localhost:6499/kay` or the port, host and port, or address given, port 0 taking a free one, the same address after every restart: `kay dev` listens there and passes each connection on to the server running, and a debugger's connection closes when the server restarts, for it to connect again; an address another process holds, at `localhost` on either loopback address, stops `kay dev`, and one past this machine needs `--host` too, as whoever reaches the debugger runs code on the machine. A page reaches it only from the dev server's own `localhost` address or `debug.bun.sh` |
| `--open` | Opens the address in the browser (the command `BROWSER` names, else the system's) once the server is ready |
| `--format text\|json` | `json` prints each line below as one JSON object on stdout, `{ "event": "ready", "time": "...", "url": "http://localhost:3000", "ms": 412 }`, with `network` under `--host`, then `restart`, `styles`, `exit`, `debugger`, `no-browser`, `builder-exit` and an `error` event for each error the server meets, the server's own output going to stderr |

When another process holds the port, the server moves to the next free one, and the ready line names the port it found in use: `kay dev: http://localhost:3001 (ready in 412 ms, 3000 was in use)`. It works however the server picks its port, and restarts keep the port it moved to, so open pages stay connected.

The dev server answers 421 to a request whose `Host` is not `localhost`, a `*.localhost` name, an IP address or the site's host, so a page of another site that renames itself to this machine (DNS rebinding) cannot read it. Any other name the server is reached by, such as a tunnel's, goes in `KAY_DEV_HOSTS`, comma-separated and without ports: `KAY_DEV_HOSTS=dev.example.com bunx kay dev --host`.

A project with no server entry, such as a static site, gets a server of kay's own on `PORT` (3000 by default).

The terminal shows the address once, then one line per restart, naming what changed and how long the new server took to listen, or how long a stylesheet edit took to reach the server, with `, now on <address>` when the address changed, and says so when the server exits on its own:

```
kay dev: http://localhost:3000 (ready in 412 ms)
14:02:31 src/routes/index.kay: restarted in 58 ms
14:02:47 src/app.css: stylesheets swapped in 24 ms
14:03:05 the server exited with code 1, waiting for a change
```

Under `--host` with no address, or one listening on every address, a second line names the address other devices on the network reach the server at, that of the first interface no container, bridge or VPN made: `kay dev: http://192.168.1.20:3000 on the network`.

In a terminal, the line under the address lists the keys `kay dev` reads: `o` opens the address in the browser, `r` restarts the server, `c` clears the screen and `q` or Ctrl+C quits. Piped, as in CI or under a coding agent, or with `--format json`, it reads no key and prints no such line.

An entry's own `Listening on http://localhost:3000` line is left out; kay's own start line only shows in production.

A project that fails to compile prints its errors there once, as the server boots, formatted as `kay check` prints them, and a request that throws prints its error with its stack mapped to `.kay` lines.

### Errors without a browser

`.kay/dev/errors.json` lists the errors the dev server met, for a reader that never opens the browser, such as a coding agent running `kay dev` in the background:

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

- `kind` is `compile` when the project failed to compile, with each problem's position in `problems` and the report `kay check` prints in `report`; `boot` when the server failed to start otherwise; `request` for a request that threw; `browser` for an error an island met, under its page's path, `island` naming its component and `report` holding the stack as the browser sent it.
- A boot failure goes once a server boots, a request's error once that method and path are answered without one, and a browser error once its page is served again.
- Requests' errors stay across restarts, the latest 50 kept. A server not run by `kay dev` writes none, nor does an entry that throws before it calls `pages()`.

### Dev tool

Every page a dev server serves carries a bar at the bottom left, `kay` and a count of the page's problems, red when one is an error. A click on it, or Alt+Shift+K, opens its drawer; Escape closes it.

- **Problems** lists, each under its heading:
  - errors nothing caught, those kay caught in an island or an effect, and unhandled rejections, with their stack;
  - what kay recovered from in the browser, such as an island that did not match its server markup;
  - what the Content-Security-Policy blocked, naming the directive and the source;
  - what axe-core finds on the rendered page, text the colour of its background counted as low contrast; hovering one outlines the elements it names;
  - what `kay check` reports of the project without type checking.

  A problem logged again shows once with how many times it came. Under `kay dev`, a `.kay` file a problem names opens in the editor on a click. Dismiss, or Dismiss all, hides a problem for the rest of the browser tab, until its text changes; those the page logged go when it is left.
- **Request** shows what served the page: the route it matched, the page and its layouts, the params, the locale, the status with the error a special page shows, and how long each load took, as the `Server-Timing` header has it. A page swap shows the next page's.
- **Routes** lists every page, endpoint and API route the server serves, each locale's copy of a page on its own line, with a filter by path or file. A path no request fills in links to itself, the page shown is marked, and the list is fetched again after each restart.
- Under `kay dev`, a file either tab names opens in the editor on a click.
- Under `kay dev`, the bar says for a few seconds after each restart or stylesheet swap what changed and how long it took, as `src/routes/index.kay: restarted in 58 ms`. A page the restart reloaded says it too. It never takes the focus. An edit that does not compile reloads the open pages into the [error page](#error-page) instead.
- The drawer follows the system's light or dark theme and docks left or right. Its open tab and side stay for the browser tab, across page swaps and reloads.

Production pages never carry it.

### Error page

A page that throws, when the app has no `_error.kay`, and a server that failed to boot show an error page in development, in the system's light or dark theme:

- the message, and the lines around where the app's own code threw;
- the app's stack frames, those of kay and the dependencies folded under one toggle;
- a Copy button, for the message and the stack as the terminal shows them;
- a compile error as `kay check` prints it.

Under `kay dev`, each frame and compile error position opens in the editor on a click. The page carries the dev tool too, and reloads itself once the error is fixed.

### Inspector

Every page `kay dev` serves knows which `.kay` line wrote each element:

- Hold Alt to outline the element under the pointer with its file, line and column, such as `h1 src/routes/index.kay:12:3`. The outline shows as soon as Alt is pressed, without moving the pointer.
- Alt+click opens that line in the editor. The click never reaches the page, so a link is not followed.
- Inspect, on the dev tool's bar, does what Alt does until the next click or Escape, for a system that keeps Alt+click for itself.
- The Islands tab, counted on the bar, lists each island's component, a click opening its file, with the values its signals hold now. The signals are numbered in the order its script creates them, and hovering a row outlines the island.

The editor is `KAY_EDITOR`, else `VISUAL` or `EDITOR` when they name VS Code, Cursor, Zed, Sublime Text, a JetBrains IDE or code-server, else the first of them on the `PATH`. `KAY_EDITOR` may be any command: it gets the position the way the editor among its words takes it, a terminal editor such as Vim, Neovim or Helix included, or else the file appended:

```sh
KAY_EDITOR=zed bun run dev
KAY_EDITOR="tmux new-window nvim" bun run dev
```

On a Linux machine with no display, as a server reached over SSH while the browser runs on another machine, only code-server can open a window: the file opens in the code-server window already open on the project, else the last one used, unless `KAY_EDITOR` names another command, such as the tmux one above.

With no editor found the page says so, and the terminal prints the position. An editor command that exits with an error within two seconds shows its error in the terminal, and the page says it failed. Tests, `pages({ dev: true })` and production builds carry none of the inspector.

## kay build

```sh
kay build  # into .kay/client
kay build --compile ./server       # one executable
kay build --static --outdir dist   # static files for a host with no server
```

The build runs `kay check` first and keeps the last build when the check or the build fails. It builds for production whatever `NODE_ENV` the shell holds, and needs none of the server's secrets, such as `preview.secret`.

| Option | Effect |
| --- | --- |
| `--compile <file>` | Also bundles the server and everything it serves into one executable |
| `--entry <file>` | The server entry to compile |
| `--static` | Also writes the whole site as static files |
| `--outdir <dir>` | Where `--static` writes, `dist` by default |
| `--no-check` | Skips the check |
| `--analyze` | Lists the modules weighing most in the entry and each island |
| `-p <tsconfig>` | Names another tsconfig |
| `--format <format>` | `text` by default; `github` annotates what the check found as `kay check --format github` does, and a template that does not compile or a failed stage too; `json` prints the whole build as one document once it ends, see [Output for tools](#output-for-tools) |

In a terminal, one line on stderr redrawn in place tells what the build is doing and since when, with a bar and a count where it knows how many routes it prerenders or images it encodes (a dynamic route counts once, however many pages it renders). With either output piped, in CI, under `NO_COLOR` or with `--format github` or `json`, it prints only the lines below, as they come.

The build prints the JavaScript a page with islands loads, gzip and minified: the entry, then what each island adds.

Every build writes `/_kay/THIRD-PARTY-LICENSES.txt`, served beside the rest and copied by `--static`: each package whose code, stylesheets or fonts the browser gets, and every `@iconify-json` set the project depends on, with its licence text. A set whose licence asks for more than that notice, such as CC BY's credit where the icons show, gets a warning. An executable prints the same notices, its server's packages added, for `./server --licenses`, with the licences of the codecs kay's AVIF encoder and decoder compile in (libavif, libaom, libsharpyuv, Emscripten's glue and musl).

## kay start

```sh
kay start              # the last build, as the deployed server runs it
kay start --port 8080
```

It serves the last `kay build` with `NODE_ENV=production`: the executable `--compile` wrote when that build made one (a later build without `--compile` drops it, and a build newer than the executable gets a warning), the server entry otherwise, or kay's own server of the pages in a project without one. It refuses to start without a build, and warns when a source changed since, naming the latest. The env files are read as the server reads them, as Bun does under `NODE_ENV=production`: `.env.production` and `.env` both, so a value only `.env` holds, such as a development database, reaches `kay start` unless `.env.production` sets it too. A variable the shell sets wins over both.

| Option | Effect |
| --- | --- |
| `--entry <file>` | Runs that server entry instead, relative to the current directory |
| `--port <port>` | The port to listen on: `--port`, else the shell's `PORT`, else the one `.env.production` or `.env` sets, else 3000 |

Ctrl-C, `SIGTERM` and `SIGHUP` reach the server once each, whether sent to the terminal's process group or to `kay start` alone, and `kay start` waits for it to drain and exit; a second Ctrl-C stops it at once. `SIGQUIT` is passed on as well, and ends the server at once (131). The server runs in a process group of its own, so Ctrl-Z suspends `kay start` but not the server, and a `SIGKILL` to the whole group, which `kay start` cannot pass on, leaves the server alone: a kay server notices `kay start` is gone within a second and drains as on `SIGTERM`, or stops as soon as it boots when `kay start` died before. `kay start` exits with the server's code, with 0 when the server ended on a stop signal it passed on, and with 128 plus the signal's number when the server died of another, as an out-of-memory kill (137) or a crash (134, 139).

## kay render

```sh
kay render /about                     # the page's HTML on stdout
kay render /account --cookie session=…
kay render /_kay/action/src/routes/index.kay/add --body 'title=Milk' -i
```

It answers one request as the server entry answers it under `NODE_ENV=development`, what it uses included, as `kay dev` serves it but without the inspector's attributes, and prints the body on stdout, so a script or an agent sees what a page renders without starting a server and fetching it. The server runs on a Unix socket of its own rather than a port, so it runs beside a `kay dev` holding the port, and stops once it answered; it builds the browser code into a directory of its own under `.kay`, removed afterwards, never touching what `kay build` or `kay dev` wrote. What the server logs, the error report of a page that throws included, goes to stderr.

The whole app boots for it, as for `kay dev`: its jobs and the top-level code of its modules run, and a `POST` to an action runs the action against the app's database. The request goes to the first server the entry starts. A full URL gives its host to the request, as a site served on several hosts or a locale's domain reads it; it is sent over plain HTTP whatever its scheme. A server that has not listened after 60 seconds fails the command.

A redirect prints `kay render: 302 Found, to /login` on stderr and nothing on stdout, and exits 0. A status of 400 or above prints its line on stderr, the body still on stdout, and exits 1. A server that exits before it serves, as on an error at the entry's top level, fails with its code. Under `base`, a path under it is taken as the proxy in front of the server hands it over, so a link a page printed renders as it is, and so does the same path without it.

| Option | Effect |
| --- | --- |
| `--method <method>` | The request's method, `GET` by default, `POST` with `--body`, which `GET` and `HEAD` refuse |
| `--body <text>` | The request's body, sent as a form posts it, `application/x-www-form-urlencoded`, unless a `--header` names another `content-type` |
| `--header <name: value>` | A request header; repeat it for more |
| `--cookie <name=value>` | A cookie; repeat it for more. A guarded page renders signed in with the session cookie a browser holds, copied from its developer tools |
| `-i`, `--include` | Prints the status line and the response's headers on stderr |
| `--entry <file>` | Runs that server entry instead, relative to the current directory |

## kay check

```sh
kay check --deny-warnings --fix
kay check src/routes/blog src/lib/feed.ts   # only the problems in those
kay check --watch
```

The first path is the project when it is a directory holding a `kay.config.ts`, a `package.json` or a `tsconfig.json`, or any directory outside the current directory, so a directory given first to narrow the report must be neither. The other paths, relative to the current directory, narrow the report, and `--fix`, to the problems in those files and directories, a symlink read as what it points to; a path outside the project fails the check. The project is still type-checked as a whole.

| Option | Effect |
| --- | --- |
| `--deny-warnings` | Fails on warnings too, not only on errors |
| `--watch` | Checks again on every change to the project, tests included, clearing the previous report in a terminal. Each check is a `kay check` of its own, so an edit to `kay.config.ts` counts and a check that cannot run, or exits before reporting, leaves the watch going. An interrupt or a closed terminal stops the check running and what it started, a second interrupt killing them |
| `--fix` | Applies the fixes that change nothing else, then reports what is left |
| `--only <group>` | Reports one group's lints alone, such as `seo`, as an audit |
| `--format <format>` | `text` by default; `github` prints each problem as a workflow command, `::error file=src/a.kay,line=4,col=3,title=missing-alt::...`, which GitHub and Forgejo Actions show on the diff, its `file` relative to `GITHUB_WORKSPACE`, the repository's root, when set, else to the current directory; `json` prints them as one document on stdout, `{ errors, warnings, problems }`, each problem with its `file` relative to the current directory, `line`, `column`, `endLine` and `endColumn` past the span, `severity`, `code`, `message`, and `label`, `note`, `help` and `related` when it has them. A check that cannot run, on a path that does not exist or a `kay.config.ts` that does not load, prints one error in the format too, `{ errors: 1, warnings: 0, problems: [{ severity, code: null, message }] }`, with the config's `file`, `line` and `column` when it does not parse. The exit code is the same in every format |
| `-p <tsconfig>` | Names another tsconfig, relative to the directory |
| `--entry <file>` | The server entry whose `app` types `ctx.locals`, `src/server.ts` by default |

`kay check` and its lints have their [own page](/reference/checks).

## kay routes

```sh
kay routes
```

```
GET   /admin/report               page      src/routes/admin/report.kay, prerendered
      layouts src/routes/_layout.kay > src/routes/admin/_layout.kay
      guards  src/routes/admin/_guard.ts
POST  /_kay/action/src/routes/index.kay/add  action  src/routes/index.kay add
GET   /api/items                  api       src/api/items.ts
GET   /old                        redirect  308 to /
GET   /_kay/health                kay       health check
```

It lists the routes the project serves in production, without starting the server or running a page or a guard: each page with its layouts and guards, outermost first, once per locale's path, `/about` and `/fr/a-propos`, with its matchers shown as its file names them, `/items/:id=integer`; each action of a page or a layout; each endpoint; each route of an API module, with its method, `WS` and `OPTIONS` included; the routes of an extension's `server` given as an Elysia instance; each redirect and collection feed; and the routes kay serves itself as the config turns them on, such as `/_kay/health`, the favicons and the sitemap. A page is marked `prerendered` with `prerender: true` or a server island, and `prerendered as its prerender setting lists` with a list or a function. `--format json` gives the routes as one document, every locale's copy with its layouts and guards ([Output for tools](#output-for-tools)). A route that sets `guards: false` is marked `open`, one that `requireGuards` refuses with a 403 says so, and a library's API module shows the guards of its own directory.

API modules are the one thing it runs, as their routes are only known once their Elysia instance is built, so their top-level code runs: what it writes to stdout, through the console or `process.stdout`, goes to stderr, off the listing, and one that fails to load, as without the server's environment, or calls `process.exit()`, is listed by its mount with why. What the server entry adds itself, such as kayjs-auth's `.use(auth.plugin)`, and an extension's `server` given as a function are only built as the server starts: a last line names them as not listed.

## kay migrate

```sh
kay migrate astro . --out ../kay-site
```

Translates an Astro project's `.astro` files into `.kay` ones, its pages into `src/routes` and its content config into kay's, then lists what is left to do by hand at its line in the Astro file. It never writes over a file that exists.

| Option | Effect |
| --- | --- |
| `[dir]` | The Astro project, the current directory by default |
| `--out <dir>` | Writes there instead of next to the `.astro` files. A directory with no `package.json` gets a whole kay project: `package.json`, `kay.config.ts`, `tsconfig.json`, a server entry when the site renders on demand, and the project's other files under `src` and `public` |

`--format json` gives what it wrote and left to do as one document ([Output for tools](#output-for-tools)).

The [Astro guide](/guides/migrating-from-astro) shows what it translates and how to finish what it lists.

## Other commands

```sh
kay explain positional-key   # one lint, with an example and the fix
kay fmt src                  # format a folder
kay fmt --check              # list unformatted files and fail
kay explain --format json    # every lint, for a tool to read
```

`kay explain` and `kay fmt` take `--format json` too ([Output for tools](#output-for-tools)).

## Output for tools

`kay build`, `kay routes`, `kay explain`, `kay fmt` and `kay migrate` take `--format json`, as `kay check` does, for a script or an agent to read: stdout then holds one JSON document on one line, what the app's own code prints through the console or `process.stdout`, such as `kay.config.ts`, an API module or a prerendered page, going to stderr; a write straight to the file descriptor, as `Bun.write(Bun.stdout, ...)`, still lands on stdout. The exit code is the one the text output gives.

| Command | Document |
| --- | --- |
| `kay build` | `{ errors, warnings, problems }` as `kay check` prints them, a template that does not compile at its place and any other failure as one problem with `code: null`; `failed: { stage }` when a stage stopped it (`check`, `bundle`, `output`, `export` or `compile`); `built: { islands, stylesheets, prerendered, entries, ms, sizes }`, `sizes` holding the entry's and each island's `raw` and `gzip` bytes, with their heaviest `modules` under `--analyze`; `exported: { pages, files, dir, ms }` with `--static`; `compiled: { executable, ms }` with `--compile` |
| `kay routes` | `{ routes, unlisted }`, each route with its `methods`, `path`, `kind`, `by` as the listing shows it, and `file`, `notes`, `layouts` and `guards` when it has them |
| `kay explain` | `{ groups, lints }`, each lint's `name`, `group`, `level` and whole `summary`; for one lint, its `name`, `level`, `group`, `summary`, the `wrong` and `right` examples, and `typed`, `site` and `launch` when set |
| `kay fmt` | `{ errors, warnings, problems, written, changed }`: what does not parse as problems, and the files it formatted, or under `--check` would, `written` false |
| `kay migrate` | `{ written, kept, copied, notes }`: the files written and those kept as they exist, how many other files it copied, and each item left to do by hand with its `file`, `line`, `target` and `message` |

Code a build runs that ends the process, such as a prerendered page calling `process.exit()`, leaves the problems found so far and one saying it ended, with the stage it ended in. A command that cannot run, on a directory that does not exist, options that do not go together, a `kay.config.ts` that does not load or a lint that is none, prints `{ errors: 1, warnings: 0, problems: [{ severity, code: null, message }] }`. Paths are relative to the current directory.

<ReadMore href="/llms/project">Every `kay new` feature, what `kay dev` restarts on, the compiled executable's limits and what `kay migrate` translates are in the full project reference.</ReadMore>
