---
title: Other editors
order: 9.65
description: Run kay's language server and formatter in Neovim, Helix and Zed.
---

Any editor that speaks the Language Server Protocol can run kay's server, and any that formats through a command can run `kay fmt --stdin`. Run both from the project root, with kay installed in the project.

The server gives errors, hover, completion, go-to-definition, references, rename, quick fixes and formatting. Only a TextMate grammar exists for highlighting `.kay` files, so Neovim, Helix and Zed show them without it until a tree-sitter grammar ships.

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

## Helix

Add this to `languages.toml`:

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
```

## Zed

Zed runs a language server and highlights a language only through an extension, and none exists for kay yet. Once an extension names the language `Kay`, this setting formats it with `kay fmt`:

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
