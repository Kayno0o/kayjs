# __APP_NAME__

A kay app. Read `node_modules/@kayjs/kay/llms.txt` before writing code: it holds kay's whole API for the version installed here, on one page. When using first-party plugins (`@kayjs/*`), also read each installed plugin's `node_modules/@kayjs/<plugin>/llms.txt` if present.

## Workflow

- **Verify changes**: run `bun run check` (`kay check` + TypeScript), `bun test` (in-process `testApp` from `@kayjs/kay/test` — no dev server needed), and `kay build --analyze` to inspect each route's JS weight and islands.
- **Discover, don't guess**: use plugin commands when installed — `kay icons-find <words>` for icon names, `kay i18n-check` for translation keys, and `kay mcp-footprint` for MCP tool token budgets.

@node_modules/@kayjs/kay/llms.txt
