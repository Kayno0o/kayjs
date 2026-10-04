# kay

A Bun web framework. A `.kay` file is one component: TypeScript fences, then a pug-like indented template. Pages render to plain HTML strings on the server, islands run on kay's own signals and DOM runtime, and an Elysia plugin serves it all, with typed form actions and type checking down to the `.kay` line.

The full reference, written for people and coding agents alike, is [llms.txt](llms.txt).

## Start a project

kay is published as `@kaynooo/kay` to the Forgejo registry at git.kaynooo.fr. Tell Bun where the `@kaynooo` scope lives once, in `~/.bunfig.toml`:

```toml
[install.scopes]
"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"
```

```sh
bunx -p @kaynooo/kay kay new my-app
cd my-app
bun install
bun run dev   # http://localhost:3000, reloads on every change
```

The project depends on it as `"kay": "npm:@kaynooo/kay@^<version>"`, so imports read `kay`, `kay/server` and so on, and carries an `.npmrc` pointing the scope at the registry. `bun src/cli.ts new ../my-app` from a checkout of this repository depends on a packed copy of it instead.

## Ship it

```sh
bun run check   # kay check: types, templates included
bun run test    # bun test, pages and actions served in-process by kay/test
bun run build   # kay build: islands, stylesheets and prerendered pages into .kay/client
bun run start   # NODE_ENV=production bun src/server.ts
```

In production the server serves what `kay build` wrote and bundles nothing at boot. `kay build --compile server` goes one step further and writes `server`, one executable holding the server, its pages and the client build, which needs neither Bun nor the project installed where it runs.

## Commands

| Command | Does |
| --- | --- |
| `kay new <dir>` | scaffold a project that checks, builds and runs |
| `kay dev [entry]` | run the server, restarting on change, errors shown in the browser |
| `kay build [dir]` | bundle the browser code for production |
| `kay build [dir] --compile <file>` | the same, plus the server and everything it serves in one executable |
| `kay check [dir]` | type-check the project, `.kay` files included |
| `kay fmt [paths] [--check]` | format `.kay` files |
| `kay lsp --stdio` | language server for the editor extension in `editors/vscode` |

## Working on kay

`bun test`, `bun run check`, `bun run lint:fix` and `bun run bench:check` must pass before a commit.
