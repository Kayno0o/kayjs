---
title: Other editors
order: 9.65
description: Highlight .kay files and run kay's language server and formatter in Neovim, Helix and Zed.
---

Any editor that speaks the Language Server Protocol can run kay's server, and any that formats through a command can run `kay fmt --stdin`. Run both from the project root, with kay installed in the project.

The server gives errors, hover, completion, go-to-definition, references, rename, quick fixes and formatting.

Highlighting comes from a tree-sitter grammar, in the `editors/tree-sitter-kay` folder of the [kay repository](https://github.com/Kayno0o/kayjs). It colours tags, classes, ids, attributes, `{}` holes and keywords, gives the script, `--- server` and `--- module` fences and every hole TypeScript, `--- style` CSS and a `markdown` block Markdown. Building it needs the `tree-sitter` CLI and a C compiler, and the editor needs the TypeScript, CSS and Markdown grammars for the embedded code.

## kay editor install

Helix and Zed need files in their own configuration folders. `kay editor install` writes them for each editor it finds on the PATH, or for the one you name:

```sh
kay editor install
kay editor install helix
```

It starts the server with `kay` when that is on the PATH, else with the kay installed in the project (`bun node_modules/kay/src/cli.ts lsp --stdio`). `kay new` offers the same step for the editors it finds, and `kay new --editor helix,zed` does it without asking.

For Helix it adds a `kay` section to `languages.toml`, copies the queries and builds the grammar. For Zed it writes an extension you load once, as the Zed section below says, and turns on the server's semantic tokens in `.zed/settings.json`.

The sections below are the same setup by hand: remove a `kay` language you declared yourself first, as the command refuses to write beside it. Helix runs the project's kay by a path relative to the project, so a project without kay installed needs `kay` on the PATH.

## Neovim

Neovim 0.11 or later. Register the file type and the server:

```lua
vim.filetype.add({ extension = { kay = 'kay' } })

vim.lsp.config('kay', {
  cmd = { 'bunx', 'kay', 'lsp', '--stdio' },
  filetypes = { 'kay' },
  root_markers = { 'kay.config.ts', 'tsconfig.json' },
})
vim.lsp.enable('kay')
```

`vim.lsp.buf.format()` then formats through the server. To format with conform.nvim instead:

```lua
require('conform').setup({
  formatters_by_ft = { kay = { 'kay' } },
  formatters = {
    kay = { command = 'bunx', args = { 'kay', 'fmt', '--stdin', '$FILENAME' }, stdin = true },
  },
})
```

For highlighting, register the grammar with the `main` branch of [nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter), then run `:TSInstall kay`. It builds the parser and installs the queries:

```lua
vim.api.nvim_create_autocmd('User', {
  pattern = 'TSUpdate',
  callback = function()
    require('nvim-treesitter.parsers').kay = {
      install_info = {
        url = 'https://github.com/Kayno0o/kayjs',
        location = 'editors/tree-sitter-kay',
        queries = 'editors/tree-sitter-kay/queries',
      },
    }
  end,
})

vim.api.nvim_create_autocmd('FileType', {
  pattern = 'kay',
  callback = function() vim.treesitter.start() end,
})
```

Add `revision = 'v<version>'`, the tag of the kay release you use, to `install_info`: without it nvim-treesitter installs the latest `main`. The grammar is in releases after 1.71.0.

## Helix

Add this to `languages.toml`, then run `hx --grammar fetch` and `hx --grammar build`:

```toml
[language-server.kay]
command = "bunx"
args = ["kay", "lsp", "--stdio"]

[[language]]
name = "kay"
scope = "source.kay"
file-types = ["kay"]
roots = ["kay.config.ts", "tsconfig.json"]
indent = { tab-width = 2, unit = "  " }
language-servers = ["kay"]
formatter = { command = "bunx", args = ["kay", "fmt", "--stdin", "%{buffer_name}"] }
auto-format = true
grammar = "kay"

[[grammar]]
name = "kay"
source = { git = "https://github.com/Kayno0o/kayjs", rev = "v<version>", subpath = "editors/tree-sitter-kay" }
```

Set `rev` to the tag of the kay release you use, or to a commit: Helix takes a commit hash or a tag, and the grammar is in releases after 1.71.0. Helix reads queries from its runtime folder, so copy them from a checkout of the repository:

```sh
mkdir -p ~/.config/helix/runtime/queries/kay
cp editors/tree-sitter-kay/queries/*.scm ~/.config/helix/runtime/queries/kay/
```

## Zed

Zed runs a language server and highlights a language only through an extension, and kay has one in the `editors/zed` folder of the repository. It adds the `Kay` language with the grammar and its queries, and starts `kay lsp --stdio` from the `kay` on the PATH, else the kay installed in the project, else through `bunx`.

`kay editor install zed` copies the extension to `kay-extension` in Zed's configuration folder (`~/.config/zed`), and you load it once: run `zed: install dev extension` from the command palette and pick that folder.

By hand, do the same from a checkout of the repository at the tag of the kay release you use (its `extension.toml` names that tag as the grammar's revision) and pick `editors/zed`. Rust installed through rustup is needed to build the extension, and Zed fetches the target and the wasi-sdk the grammar needs.

This setting then formats the language with `kay fmt`:

```json
{
  "languages": {
    "Kay": {
      "formatter": {
        "external": { "command": "bunx", "arguments": ["kay", "fmt", "--stdin", "{buffer_path}"] }
      }
    }
  }
}
```

## kay fmt --stdin

`kay fmt --stdin [path]` reads a source on stdin and prints it formatted on stdout. The path names the file it is for, which need not exist yet, and decides the Tailwind order of its classes. A source that does not compile prints its problems on stderr, nothing on stdout and exits 1, so an editor keeps the buffer as it is.

```sh
echo 'div.p-4.flex x' | kay fmt --stdin src/routes/index.kay
```
