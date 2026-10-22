# Kay

Language support for `.kay` components, the pug-like templates over TypeScript of [kay](https://kayjs.kaynooo.fr).

- Highlighting for the template and the script and server fences.
- Errors, hover, completion with auto-import, go-to-definition, references, rename, quick fixes and formatting, from the `kay lsp` of the kay your project installed.
- One language server per project: every folder with a `kay.config.ts`, monorepos, multi-root workspaces and a project nested in another (it has its own server, which the outer one leaves its files to) included. The server starts once kay is installed.
- Snippets for a page, a component and an island.
- Commands: Kay: Restart the language server, Run kay check, Open the dev server, Show the output.

The extension needs [Bun](https://bun.sh) on the PATH, or `kay.bun.path`, and kay installed in the project.

| Setting | What it does |
| --- | --- |
| `kay.bun.path` | The Bun executable running the server, `bun` by default |
| `kay.server.path` | The kay CLI to run, when it is not the project's own |
| `kay.routes` | The pages directory, when `kay.config.ts` does not name it |
| `kay.lsp.trace` | Traces the editor and server messages into the output |
| `kay.dev.url` | The address of Kay: Open the dev server |
