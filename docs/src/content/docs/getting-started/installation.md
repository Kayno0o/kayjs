---
title: Installation
order: 3
description: Point Bun at the registry, scaffold a project with kay new and start the dev server.
---

You need [Bun](https://bun.sh) 1.4.3 or later. kay is published as `@kaynooo/kayjs` on its own registry, so tell Bun where the `@kaynooo` scope lives once.

A project depends on it under the name `kay`, `"kay": "npm:@kaynooo/kayjs@~<version>"` in `package.json`, which is why imports read `kay` and `kay/server`. `kay new` writes that line for you.

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

The app is at `http://localhost:3000` and reloads on every change, and Alt+click on an element opens its `.kay` line in your editor (see the [inspector](/reference/cli#inspector)). Run in a terminal, `kay new` asks for a preset, then for each [feature](/reference/cli#features). Pass `--template` to skip the questions.

| Preset | What you get |
| --- | --- |
| `blank` | One layout and one bare page, built as a static site |
| `server` | An Elysia server, a layout, a header, Tailwind and a counter island (the default) |
| `site` | A static site: `bun run build` writes plain files for any host |
| `app` | The server plus sessions, a demo sign-in action (refused in production unless `DEMO_SIGN_IN=true`), members in Postgres and a websocket island |

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

The `.kay` extension for VS Code, in `editors/vscode` of the kay repository, highlights `.kay` files and runs `kay lsp` for errors, hover, completion with auto-import, go-to-definition, references, rename, quick fixes and formatting. It is not on the Marketplace: build it from a checkout of the repository and install the file it writes.

```sh
cd editors/vscode
bun install
bun run package   # writes kay.vsix
code --install-extension kay.vsix
```

The extension runs the language server of the kay the workspace installed, so it always matches the compiler the project builds with, and asks for nothing more in a project made by `kay new`. Three settings change that:

| Setting | What it does |
| --- | --- |
| `kay.bun.path` | The Bun executable running the server, `bun` by default |
| `kay.server.path` | The kay CLI to run, absolute or relative to the workspace, when it is not the workspace's own |
| `kay.routes` | The pages directory, so route params and links are typed; by default the one `kay.config.ts` names, else `src/routes` |

Any other editor speaking the Language Server Protocol, such as Neovim, Helix or Zed, can run the same server: start `bunx kay lsp --stdio` in the project root for `.kay` files. The server runs the project's `kay.config.ts` when a `.kay` file opens, so open only a project you trust. The TextMate grammar ships as `kay/kay.tmLanguage.json` for an editor or highlighter that takes one.

## Troubleshooting

kay refuses a Bun older than 1.4.3 and says how to update it. When that Bun is the npm `bun` package a dependency installed, which package scripts run ahead of the system Bun, `bun update bun` in the project updates it.

<ReadMore href="/llms/project">Every `kay` command, the `kay new` features and the tsconfig details are in the project reference.</ReadMore>
