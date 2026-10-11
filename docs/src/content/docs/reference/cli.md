---
title: CLI
order: 1
description: The kay commands to scaffold, run, check, build and format a project.
---
`kay dev`, `kay build` and `kay check` take an optional project directory (the current one by default), and every command prints its usage for `--help`.

```sh
bunx -p @kaynooo/kayjs kay new my-app
cd my-app
bun run dev
```

| Command | Does |
| --- | --- |
| `kay new <dir>` | Scaffold a project that checks, builds and runs |
| `kay dev [dir]` | Run the server, restarting on change, with errors shown in the browser |
| `kay build [dir]` | Check the project and bundle the browser code for production |
| `kay check [dir]` | Type-check the project, `.kay` files included |
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

`kay dev` builds the browser code itself while the server boots, in a process it keeps from one change to the next, and the server reads that build as a production server reads `kay build`'s. An edit builds again only what it reaches: a change to a server module restarts the server alone, and an edit to stylesheets alone swaps them into the open pages without restarting anything. A `pages()` given options for the browser build that `kay.config.ts` does not hold bundles its own as it boots, and says so: keep those options in `kay.config.ts`.

| Option | Effect |
| --- | --- |
| `--entry <file>` | The server entry, when it is not `src/server.ts` |
| `--port <port>` | Sets `PORT` for the server, over the shell's and the `.env`'s |
| `--inspect[=<address>]` | Opens Bun's debugger in the server, at `ws://localhost:6499/kay` or the port, host and port, or address given, port 0 taking a free one, the same address after every restart: `kay dev` listens there and passes each connection on to the server running, and a debugger's connection closes when the server restarts, for it to connect again; an address another process holds stops `kay dev` |
| `--open` | Opens the address in the browser (the command `BROWSER` names, else the system's) once the server is ready |

When another process holds the port, the server moves to the next free one, and the ready line names the port it found in use: `kay dev: http://localhost:3001 (ready in 412 ms, 3000 was in use)`. It works however the server picks its port, and restarts keep the port it moved to, so open pages stay connected.

A project with no server entry, such as a static site, gets a server of kay's own on `PORT` (3000 by default).

The terminal shows the address once, then one line per restart, naming what changed and how long the new server took to listen, or how long a stylesheet edit took to reach the server, with `, now on <address>` when the address changed, and says so when the server exits on its own:

```
kay dev: http://localhost:3000 (ready in 412 ms)
14:02:31 src/routes/index.kay: restarted in 58 ms
14:02:47 src/app.css: stylesheets swapped in 24 ms
14:03:05 the server exited with code 1, waiting for a change
```

The `Listening on http://localhost:3000` line an entry scaffolded by an older kay prints is left out; kay's own start line only shows in production.

### Inspector

Every page `kay dev` serves knows which `.kay` line wrote each element:

- Hold Alt to outline the element under the pointer with its file, line and column, such as `h1 src/routes/index.kay:12:3`. The outline shows as soon as Alt is pressed, without moving the pointer.
- Alt+click opens that line in the editor. The click never reaches the page, so a link is not followed.
- On a page with islands, the button at the bottom left lists each island's component, a click opening its file, with the values its signals hold now. The signals are numbered in the order its script creates them, and hovering a row outlines the island.

The editor is `KAY_EDITOR`, else `VISUAL` or `EDITOR` when they name VS Code, Cursor, Zed, Sublime Text, a JetBrains IDE or code-server, else the first of them on the `PATH`. `KAY_EDITOR` may be any command: it gets the position the way the editor among its words takes it, a terminal editor such as Vim, Neovim or Helix included, or else the file appended:

```sh
KAY_EDITOR=zed bun run dev
KAY_EDITOR="tmux new-window nvim" bun run dev
```

On a Linux machine with no display, as a server reached over SSH while the browser runs on another machine, only code-server can open a window: the file opens in the code-server window already open on the project, else the last one used, unless `KAY_EDITOR` names another command, such as the tmux one above.

With no editor found the page says so, and the terminal prints the position. An editor command that exits with an error within two seconds shows its error in the terminal, and the page says it failed. Tests, `pages({ dev: true })` and production builds carry none of it.

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

The build prints the JavaScript a page with islands loads, gzip and minified: the entry, then what each island adds.

## kay start

```sh
kay start              # the last build, as the deployed server runs it
kay start --port 8080
```

It serves the last `kay build` with `NODE_ENV=production`: the executable `--compile` wrote when that build made one, the server entry otherwise, or kay's own server of the pages in a project without one. It refuses to start without a build, and warns when a source changed since, naming the latest. `.env` is read as the server reads it, `.env.production` included, not as the shell running `kay start` holds it.

| Option | Effect |
| --- | --- |
| `--entry <file>` | Runs that server entry instead |
| `--port <port>` | The port to listen on, `PORT` or 3000 otherwise |

## kay check

```sh
kay check --deny-warnings --fix
```

| Option | Effect |
| --- | --- |
| `--deny-warnings` | Fails on warnings too, not only on errors |
| `--fix` | Applies the fixes that change nothing else, then reports what is left |
| `--only <group>` | Reports one group's lints alone, such as `seo`, as an audit |
| `-p <tsconfig>` | Names another tsconfig, relative to the directory |
| `--entry <file>` | The server entry whose `app` types `ctx.locals`, `src/server.ts` by default |

`kay check` and its lints have their [own page](/reference/checks).

## kay migrate

```sh
kay migrate astro . --out ../kay-site
```

Translates an Astro project's `.astro` files into `.kay` ones, its pages into `src/routes` and its content config into kay's, then lists what is left to do by hand at its line in the Astro file. It never writes over a file that exists.

| Option | Effect |
| --- | --- |
| `[dir]` | The Astro project, the current directory by default |
| `--out <dir>` | Writes there instead of next to the `.astro` files. A directory with no `package.json` gets a whole kay project: `package.json`, `kay.config.ts`, `tsconfig.json`, a server entry when the site renders on demand, and the project's other files under `src` and `public` |

The [Astro guide](/guides/migrating-from-astro) shows what it translates and how to finish what it lists.

## Other commands

```sh
kay explain positional-key   # one lint, with an example and the fix
kay fmt src                  # format a folder
kay fmt --check              # list unformatted files and fail
```

<ReadMore href="/llms/project">Every `kay new` feature, what `kay dev` restarts on, the compiled executable's limits and what `kay migrate` translates are in the full project reference.</ReadMore>
