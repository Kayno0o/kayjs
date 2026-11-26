---
title: "@kayjs/mcp"
description: Zero-dependency MCP Streamable HTTP (2025-03-26) plugin exposing typed Kay v2 server actions as bearer-authenticated AI agent tools.
section: plugins
order: 7
---

`@kayjs/mcp` exposes your existing Kay v2 server `action()` handlers as **Model Context Protocol (MCP)** tools over Streamable HTTP (`2025-03-26`). Core stays free of MCP code — `@kayjs/mcp` mounts strictly as an opt-in `KayPlugin` at `/mcp/tools` (configurable).

## 1. Install and register in `kay.config.ts`

```bash
bun add @kayjs/mcp
```

```ts
// kay.config.ts
import { mcp } from '@kayjs/mcp'
import { defineConfig } from '@kayjs/kay/config'
import { listNotes, writeNote } from './src/actions/notes'

export default defineConfig({
  plugins: [
    mcp({
      name: 'my-app',
      version: '1.0.0',
      // Default endpoint: '/mcp/tools'
      token: { env: 'MCP_TOKEN' }, // or inline string, or { file: '/run/secrets/mcp.key' }
      tools: {
        list: {
          action: listNotes,
          description: 'Lists saved notes.',
        },
        write: {
          action: writeNote,
          description: 'Creates a note with a kebab-case title.',
        },
      },
    }),
  ],
})
```

## 2. Compact schemas, shared schemas & resources

- **Automatic schema compaction**: Any Standard Schema v1 library implementing Standard JSON Schema v1 (`~standard.jsonSchema.input`, such as Zod 4, Valibot, or ArkType) populates `inputSchema` in `tools/list`. By default `@kayjs/mcp` strips `$schema`, `$id`, `x-*` extensions, empty `required`, `additionalProperties: true`, unused `$defs`, no-op bounds (`minLength: 0`, `±MAX_SAFE_INTEGER`), form-coercion string branches in `anyOf`/`oneOf`, and folds optional homogeneous record objects (≥ 4 identical-schema keys) into `additionalProperties` with a compact `Keys: ...` description. Pass `compactSchemas: false` or a `CompactSchemaOptions` object to tune it.
- **Shared schemas on demand (`schemas` + `schemaRef`)**: When several tools accept the same large config object, register it once under `schemas` and point each tool to `schemaRef`. Server-side validation still enforces the full schema, while `tools/list` sends a short stub and exposes a `describe_schema` tool plus a `kay://schemas/<name>` resource.
- **On-demand `resources`**: Put long docs, enum tables, or style guides in `resources` (served via `resources/list` and `resources/read`) instead of repeating them in tool descriptions or `instructions`.
- **Actionable errors & form redirects**: Schema validation failures, `ctx.deny(status, message, fieldErrors)` responses (including `fieldErrors`), and thrown errors map to MCP tool results with `isError: true`. `3xx` redirects from reused form actions return a short `ok -> <location>` receipt instead of failing.

```ts
mcp({
  token: { env: 'MCP_TOKEN' },
  schemas: { siteConfig: siteConfigSchema },
  resources: {
    'kay://docs/finding-kinds': {
      description: 'All valid finding kinds.',
      read: FINDING_KINDS_TEXT,
    },
  },
  tools: {
    create_site: { action: createSite, description: 'Create a site.', schemaRef: 'siteConfig' },
    edit_site: { action: editSite, description: 'Edit a site.', schemaRef: 'siteConfig' },
  },
})
```

## 3. Token-efficient outputs & footprint budgets

Web actions often return full records, `null` columns, or large lists. `@kayjs/mcp` includes built-in controls to keep both `tools/list` and tool outputs lean:

```ts
import { formatLines, inspectMcpFootprint, mcp, mcpTool } from '@kayjs/mcp'

mcp({
  token: { env: 'MCP_TOKEN' },
  pruneEmpty: true,       // drop null, undefined, [], {} from JSON outputs (or 'nullish')
  maxOutputChars: 12_000, // cap oversized results with a truncation hint
  budget: { maxToolBytes: 2048 }, // warn in dev & `kay check` (set `strict: true` to fail check)
  tools: {
    list: mcpTool({
      action: listNotes,
      description: 'List saved notes.',
      annotations: { readOnlyHint: true },
      format: out => formatLines(out.notes, n => `#${n.id} ${n.title}`),
    }),
    write: mcpTool({
      action: writeNote,
      description: 'Create a note with a kebab-case title.',
      format: created => `created #${created.id} (${created.title})`,
    }),
  },
})
```

- **`format` / `formatResult`**: Transform an `action()` return value into a short receipt, compact lines (`formatLines`), or TSV (`formatTable`) without changing the web action.
- **`pruneEmpty`**: Set `'nullish'` to strip `null`/`undefined`, or `true` to also drop empty arrays and objects from JSON responses.
- **`maxOutputChars`**: Global or per-tool character guard that truncates runaway payloads cleanly.
- **`kay mcp-footprint` & `inspectMcpFootprint()`**: Print or assert each tool's bytes, `description` vs `schema` split, and estimated tokens. In dev and `kay check`, tools over `budget.maxToolBytes` (default `2048` B) trigger a warning.

### Keeping `tools/list` small

Clients that load every MCP tool up front pay your whole `tools/list` on every turn:

- Keep descriptions to one short sentence; put long enum lists or domain help in `resources` or return valid values in error messages.
- Prefer one tool with an enum `op` / `kind` parameter over several near-identical tools.
- Use `schemas` + `schemaRef` whenever two or more tools share a large nested object.

## 4. Bearer token security

| State | HTTP response |
| :--- | :--- |
| Token unconfigured / missing env var / missing file | `404 Not Found` (endpoint hidden) |
| Missing or invalid `Authorization: Bearer <token>` | `401 Unauthorized` (`WWW-Authenticate: Bearer`) |
| Valid token (constant-time SHA-256 comparison) | `200 OK` JSON-RPC 2.0 (`202 Accepted` on notifications) |

<Callout title="Works cleanly in --compile binaries" tone="info">
Because `@kayjs/mcp` uses `token: { env: '...' }` or `token: { file: '...' }` at request time, secrets are never baked into your standalone binary and can be rotated on disk without rebuilding.
</Callout>
