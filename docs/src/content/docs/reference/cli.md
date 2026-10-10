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
| `kay explain [lint]` | List the lints, or explain one |
| `kay fmt [paths]` | Format `.kay` files |
| `kay migrate astro [dir]` | Translate an Astro project into `.kay` files |
| `kay lsp --stdio` | The language server behind the editor extension |

## kay new

```sh
kay new my-app --template app --without docker
```

| Option | Effect |
| --- | --- |
| `--template blank\|server\|site\|app` | The preset: one bare static page, an Elysia server (the default), a static site, or a server with sessions and members in Postgres |
| `--with <features>` | Adds comma-separated features to the preset, such as `tailwind,tests` |
| `--without <features>` | Drops features from the preset |
| `-y` | Takes the `server` preset without asking |

In a terminal with none of these options, `kay new` asks for a preset, then for each feature.

## kay dev

`kay dev` runs `src/server.ts` with `NODE_ENV=development`. Open pages refresh by themselves, an edited island is swapped in place, and a project that fails to compile shows its errors in the browser.

| Option | Effect |
| --- | --- |
| `--entry <file>` | The server entry, when it is not `src/server.ts` |

A project with no server entry, such as a static site, gets a server of kay's own on `PORT` (3000 by default).

The terminal shows the address once, then one line per restart, naming what changed and how long the new server took to listen, and says so when the server exits on its own:

```
kay dev: http://localhost:3000 (ready in 412 ms)
14:02:31 src/routes/index.kay: restarted in 58 ms
14:02:47 src/app.css and 1 more: restarted in 61 ms
14:03:05 the server exited with code 1, waiting for a change
```

The entry's own `Listening on http://localhost:3000` line, which the templates print in production, is left out.

## kay build

```sh
kay build  # into .kay/client
kay build --compile ./server       # one executable
kay build --static --outdir dist   # static files for a host with no server
```

The build runs `kay check` first and keeps the last build when the check or the build fails.

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

## kay check

```sh
kay check --deny-warnings --fix
```

| Option | Effect |
| --- | --- |
| `--deny-warnings` | Fails on warnings too, not only on errors |
| `--fix` | Applies the fixes that change nothing else, then reports what is left |
| `-p <tsconfig>` | Names another tsconfig, relative to the directory |
| `--entry <file>` | The server entry whose `app` types `ctx.locals`, `src/server.ts` by default |

`kay check` and its lints have their [own page](/reference/checks).

## Other commands

```sh
kay explain positional-key   # one lint, with an example and the fix
kay fmt src                  # format a folder
kay fmt --check              # list unformatted files and fail
kay migrate astro . --out ../kay-site
```

<ReadMore href="/llms/project">Every `kay new` feature, what `kay dev` restarts on, the compiled executable's limits and what `kay migrate` translates are in the full project reference.</ReadMore>
