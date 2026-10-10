---
title: Installation
order: 2
description: Point Bun at the registry, scaffold a project with kay new and start the dev server.
---

You need [Bun](https://bun.sh). kay is published as `@kaynooo/kayjs` on its own registry, so tell Bun where the `@kaynooo` scope lives once.

## Registry setup

In `~/.bunfig.toml`, or `$XDG_CONFIG_HOME/.bunfig.toml` when that variable is set, as Bun then reads only that one:

```toml
[install.scopes]
"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"
```

## Create a project

```sh
bunx -p @kaynooo/kayjs kay new my-app
cd my-app
bun install
bun run dev
```

The app is at `http://localhost:3000` and reloads on every change. Run in a terminal, `kay new` asks for a preset, then for each feature. Pass `--template` to skip the questions.

| Preset | What you get |
| --- | --- |
| `blank` | One layout and one bare page, built as a static site |
| `server` | An Elysia server, a layout, a header, Tailwind and a counter island (the default) |
| `site` | A static site: `bun run build` writes plain files for any host |
| `app` | The server plus sessions, a sign-in action, members in Postgres and a websocket island |

`--with` and `--without` change a preset's features, for example `--without tailwind,accents`, as the accent picker needs Tailwind.

## Scripts

A new project comes with these:

```sh
bun run dev     # kay dev: the server, restarting on change
bun run check   # kay check: types, templates included
bun run build   # kay build: the production bundle
bun run start   # the production server, after a build
```

## Editor

The `.kay` extension for VS Code (`editors/vscode` in the kay repository) adds highlighting, errors, completion, go-to-definition and formatting through `kay lsp`.

<ReadMore href="/llms/project">Every `kay` command, the `kay new` features and the tsconfig details are in the project reference.</ReadMore>
