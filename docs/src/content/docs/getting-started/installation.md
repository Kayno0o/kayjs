---
title: Installation
order: 3
description: Point Bun at the registry, scaffold a project with kay new and start the dev server.
---

You need [Bun](https://bun.sh) 1.4.3 or later. kay is published as `@kaynooo/kayjs` on its own registry, not on npm. Tell Bun where the `@kaynooo` scope lives once, then create a project.

A project depends on kay under the name `kay`, so imports read `kay` and `kay/server`. `kay new` writes the line `"kay": "npm:@kaynooo/kayjs@~<version>"` in `package.json` for you.

## Registry setup

Add the scope to `~/.bunfig.toml`. When `$XDG_CONFIG_HOME` is set, use `$XDG_CONFIG_HOME/.bunfig.toml` instead, because Bun then reads only that file.

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

The app is at `http://localhost:3000` and reloads on every change. Alt+click on an element opens its `.kay` line in your editor, through the [inspector](/guides/performance#the-inspector).

Run in a terminal, `kay new` asks for a preset, then for each [feature](/reference/cli#features). Pass `--template` to skip the questions.

| Preset | What you get |
| --- | --- |
| `blank` | One layout and one bare page, built as a static site |
| `server` | An Elysia server, a layout, a header, Tailwind and a counter island (the default) |
| `site` | A static site: `bun run build` writes plain files for any host |
| `app` | The server plus kayjs-auth sign-in, register and account pages (its users in SQLite) and a websocket island |

`--with` and `--without` change a preset's features. The accent picker needs Tailwind, so drop both together: `--without tailwind,accents`.

## Scripts

Every new project comes with `dev`, `check` and `build`. The server presets add `start`, and `build` of a static preset writes plain files with `kay build --static`.

```sh
bun run dev     # kay dev: the server, restarting on change
bun run check   # kay check: types, templates included
bun run build   # kay build: the production bundle
bun run start   # kay start: the production server, after a build (server presets)
```

## Editor

The `.kay` extension for VS Code highlights `.kay` files and runs `kay lsp`. You get errors, hover, completion with auto-import, go-to-definition, references, rename, quick fixes, formatting, an outline, folding, and imports updated when you rename or move a `.kay` file. Completion also offers element, attribute, prop and block names, route paths in `href`, `action` and `navigate()`, `t()` message keys and lint names after `// kay-allow`.

Install **Kay** (`kaynooo.kay`) from the VS Code Marketplace, or from Open VSX in VSCodium and other builds. Each release also attaches its `kay-<version>.vsix`, which `code --install-extension` installs. A project made by `kay new` recommends it in `.vscode/extensions.json`, so VS Code offers it when the folder opens, and formats `.kay` files on save with it.

The extension runs the language server of the kay the project installed, one server per project: every folder holding a `kay.config.ts`, in a monorepo or a multi-root workspace too, and a project nested in another has its own server, which the outer one leaves its files to. It always matches the compiler the project builds with, and it starts once kay is installed. A project made by `kay new` needs no setup. These settings change that.

| Setting | What it does |
| --- | --- |
| `kay.bun.path` | The Bun executable running the server, `bun` by default |
| `kay.server.path` | The kay CLI to run, absolute or relative to the workspace, when it is not the workspace's own |
| `kay.routes` | The pages directory, so route params and links are typed. By default the one `kay.config.ts` names, else `src/routes` |
| `kay.lsp.trace` | `off`, `messages` or `verbose`: traces the messages between the editor and the server into its output |
| `kay.dev.url` | The address the Open the dev server command opens, `http://localhost:3000` by default |

The command palette has Kay: Restart the language server, Run kay check (in a terminal), Open the dev server and Show the output. The extension adds snippets too: `page`, `pageserver`, `component` and `island`.

A project made with Tailwind also gets Tailwind CSS IntelliSense settings in `.vscode/settings.json`: it reads `.kay` files as HTML and finds the classes of the `.class` shorthand and of `class="..."`, so completion and hover work in both. The extension matches by pattern, so a line of a script fence such as `console.log(` can show Tailwind hovers too.

Any editor that speaks the Language Server Protocol, such as Neovim, Helix or Zed, can run the same server. Start `bunx kay lsp --stdio` in the project root for `.kay` files.

The server runs the project's `kay.config.ts` when a `.kay` file opens, so open only a project you trust.

An editor or highlighter that takes a TextMate grammar can use `kay/kay.tmLanguage.json`.

## Troubleshooting

kay refuses a Bun older than 1.4.3 and says how to update it.

If the old Bun is the npm `bun` package that a dependency installed, run `bun update bun` in the project. Package scripts run that copy ahead of the system Bun.

<ReadMore href="/llms/project">Every `kay` command, the `kay new` features and the tsconfig details.</ReadMore>
