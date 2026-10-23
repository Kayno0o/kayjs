---
title: Other editors
order: 9.65
description: Highlight .kay files and run kay's language server and formatter in Neovim, Helix and Zed.
---

Any editor that speaks the Language Server Protocol can run kay's server, and any that formats through a command can run `kay fmt --stdin`. Run both from the project root, with kay installed in the project.

The server gives errors, hover, completion, go-to-definition, references, rename, quick fixes and formatting.

Highlighting comes from a tree-sitter grammar, in the `editors/tree-sitter-kay` folder of the [kay repository](https://github.com/Kayno0o/kayjs). It colours tags, classes, ids, attributes, `{}` holes and keywords, gives the script, `--- server` and `--- module` fences and every hole TypeScript, `--- style` CSS and a `markdown` block Markdown. Building it needs the `tree-sitter` CLI and a C compiler, and the editor needs the TypeScript, CSS and Markdown grammars for the embedded code.

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

It installs the latest `main`: add `revision = '<commit or tag>'` to `install_info` to pin a version.

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
source = { git = "https://github.com/Kayno0o/kayjs", rev = "main", subpath = "editors/tree-sitter-kay" }
```

Replace `rev = "main"` with a commit or a tag to pin the grammar. Helix reads queries from its runtime folder, so copy them from a checkout of the repository:

```sh
mkdir -p ~/.config/helix/runtime/queries/kay
cp editors/tree-sitter-kay/queries/*.scm ~/.config/helix/runtime/queries/kay/
```

## Zed

Zed runs a language server and highlights a language only through an extension, and kay has one in the `editors/zed` folder of the repository. It adds the `Kay` language with the grammar and its queries, and starts `kay lsp --stdio` from the `kay` on the PATH, or through `bunx` when there is none.

In a checkout of the repository, run `zed: install dev extension` from the command palette and pick `editors/zed`. Rust installed through rustup is needed to build the extension, and Zed fetches the target and the wasi-sdk the grammar needs.

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
