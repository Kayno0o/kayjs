# Language server, screenshot and MCP commands

`kay lsp` serves an editor, `kay screenshot` photographs a page of `kay dev`, and `kay mcp` gives an agent kay's tools. The other commands are in [Check, inspect and tool commands](check-and-tools.md).

## Common tasks

### Serve an editor

`kay lsp --stdio` is the server behind the VS Code extension `kaynooo.kay` (Marketplace and Open VSX, and a `kay-<version>.vsix` on each release; sources in `editors/vscode`):

```sh
kay lsp --stdio
```

The extension starts one server per project, each folder holding a `kay.config.ts` (a monorepo's apps, a multi-root workspace's folders, a project nested in another, which owns its files) once kay is installed in it, and adds the commands Kay: Restart the language server, Run kay check, Open the dev server and Show the output, the settings `kay.bun.path`, `kay.server.path`, `kay.routes`, `kay.lsp.trace` and `kay.dev.url`, and the snippets `page`, `pageserver`, `component` and `island`. `kay new` writes `.vscode/extensions.json` recommending it, and format-on-save for `.kay` in `.vscode/settings.json`.

### Photograph a page of the dev server

With `kay dev` running, `kay screenshot` shoots a path at two widths and writes the files under `.kay/screenshots`:

```sh
kay screenshot /posts --scheme dark
```

### Give an agent kay's tools

`kay mcp` serves the project to an agent over stdio; register it once:

```sh
claude mcp add kay -- bunx kay mcp
```

## Reference

- `kay lsp --stdio`:
  - The language server behind the editor extension in `editors/vscode`: errors, hover, completion with auto-import, signatures, definitions, references, rename, quick fixes and formatting in `.kay` files, plus an outline, folding, a `source.fixAll.kay` action applying every safe fix, links from a relative import to the file it names, and the relative imports of other `.kay` files and of TypeScript modules rewritten when one is renamed or moved, a `.kay` import written without its extension included.
  - Outside a `{expr}` it completes element names, block keywords and the `@` blocks of a component at a line start, attribute and event names (a component's props, read from its type or, for a package's component or a type imported from another file, from TypeScript) inside `(...)`, across lines, route paths after `href="`, `action="` and `navigate('`, `t('` message keys of the default locale, and lint names after `// kay-allow`.
  - An import it adds goes in the fence the name is used from, the server fence for server code and the component script otherwise, made if missing.
  - Renaming a server value renames its reads in the template, and renaming a destructured prop renames it in every parent passing it.
  - It runs the project's `kay.config.ts`, and the modules it imports, as soon as a `.kay` file is opened, as `bun` would: open only a project you trust, as with its `package.json` scripts.
- `kay screenshot <path> [dir] [--width <px>]... [--height <px>] [--scheme light|dark] [--full-page] [--cookie <name=value>]... [--format text|json]`:
  - Needs `kay dev` running in the project (it writes `.kay/dev/server-<pid>.json`, `{ url, pid }`, one per `kay dev`, and removes it on exit; a dead pid is ignored, the latest written wins) and Chrome or Chromium; it says so, naming `BUN_CHROME_PATH`, otherwise.
  - `path` is what a visitor types, a locale prefix and a query included; a site's `base` is added when the path is not under it, and the page is opened through a proxy of the command's own that takes it off, as a proxy in front of the site does. A path that does not start with one `/`, holds a `..` segment (also percent-encoded), a backslash or a control character, or names another host is refused before the browser starts.
  - Widths 375 and 1280 by default, 200 to 3840; `--height` 200 to 8000, 800 by default; `--full-page` shoots the whole page, cut at 8000 px. The window is exact: a device metrics override replaces the browser's bar. `kay-dev`'s badge is hidden.
  - Each shot is `.kay/screenshots/<path>.<width>[x<height>].<scheme>[.full].png`, the path written in letters, digits and `-` with `_` and the hex of anything else. The one before goes to `.prev.png` and `.diff.png` marks the changed pixels red on the faded new shot, with the count, ratio and bounding box of the changes (a different size is compared on the larger canvas, a tolerance of 8 per channel ignoring anti-aliasing; beyond 12 million pixels in either shot no diff is made and the shot says `diffSkipped`). Two shots of one page at once wait for each other. Beyond 240 files the oldest go.
  - The document (`--format json`, else one line per shot): `url`, the dev server's `status`, `shots` (`width`, `scheme`, `file`, `size`, `cut`, `previous`, `diff`, `diffSkipped`), `console` (the page's console errors and uncaught exceptions, and `kay: timed out after ...` when it did not load and hydrate within 10 s, in which case it is shot as it stands) and `problems` (the entries of `.kay/dev/errors.json` for the page, and a boot or compile failure). A status of 400 or above is a result, not a failure. `url` is the one asked for: a redirect, such as a guarded page sending a visitor to its sign-in, is followed and shot, and no cookie is sent unless `--cookie name=value` gives one (repeat it), so a page behind a session is shot with the session's cookie. A `--cookie` value is an argument, so `ps` shows it while the command runs: use a throwaway session of a dev database.
- `kay mcp [--stdio]`:
  - Serve the project in the current directory to an agent as an MCP server over stdio (newline-delimited JSON-RPC), in both the revision that opens with `initialize` (`2025-11-25` and earlier) and `2026-07-28`, whose requests carry their version in `_meta`; it needs no setup in the app and prints nothing but protocol on stdout.
  - Tools, each with an input schema: `check` runs `kay check --format json` and answers its document, taking `paths` (files or directories inside the project to report on, `.` for all of it; the project is checked whole either way), `only` (a lint group) and `denyWarnings`; `routes` answers `kay routes --format json`; `explain` lists the lints and error codes, or explains the lint, error code or group in `name`; `render` runs `kay render` on `url` with `method`, `body`, `headers` (`name: value`) and `cookies` (`name=value`), answering the body (an image or a blob, unchanged, when it is not text), then the status line, headers and server log, as an error result for a status of 400 or above; `screenshot` (a call can take a minute, and the others wait for it) runs `kay screenshot --format json` and answers its document, then each shot's PNG as an image, and the diff image of each too with `diff: true`; `dev_errors` reads `.kay/dev/errors.json` (see `kay dev`), an empty list when `kay dev` has met nothing; `doctor` answers `kay doctor --format json` with `port`, a failing check being a result.
  - Each tool runs the command in a child process of its own, so a call pays what the command costs, a `check` as long as `kay check`; a problem found is a result, a command that could not run an error result (`isError`). Calls run one at a time, in the order they came, and a command that is stopped (timeout, client gone) takes what it started along.
  - Resources: `kay://llms.txt`, and `kay://llms/<file>.md` for each file of `llms/`, with the file's title and the headings of its sections as description; only those are readable.
  - Register it with `claude mcp add kay -- bunx kay mcp`, or as `{ "mcpServers": { "kay": { "command": "bunx", "args": ["kay", "mcp"] } } }` in a client's JSON config.
