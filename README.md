# kay

A Bun web framework. A `.kay` file is one component: TypeScript fences, then a pug-like indented template. It compiles to TSX, runs on Solid 2 and is served by an Elysia plugin, with server rendering, islands, typed form actions and type checking down to the `.kay` line.

The full reference, written for people and coding agents alike, is [llms.txt](llms.txt).

## Start a project

```sh
bun src/cli.ts new ../my-app   # from this checkout, until kay is published
cd ../my-app
bun install
bun run dev                    # http://localhost:3000, reloads on every change
```

## Ship it

```sh
bun run check   # kay check: types, templates included
bun run build   # kay build: islands, stylesheets and prerendered pages into .kay/client
bun run start   # NODE_ENV=production bun src/server.ts
```

In production the server serves what `kay build` wrote and bundles nothing at boot.

## Commands

| Command | Does |
| --- | --- |
| `kay new <dir>` | scaffold a project that checks, builds and runs |
| `kay dev [entry]` | run the server, restarting on change, errors shown in the browser |
| `kay build [dir]` | bundle the browser code for production |
| `kay check [dir]` | type-check the project, `.kay` files included |
| `kay fmt [paths] [--check]` | format `.kay` files |
| `kay lsp --stdio` | language server for the editor extension in `editors/vscode` |

## Working on kay

`bun test`, `bun run check`, `bun run lint:fix` and `bun run bench:check` must pass before a commit.
