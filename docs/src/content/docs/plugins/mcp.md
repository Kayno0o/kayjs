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
import { defineConfig } from 'kay/server'
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

## 2. Standard JSON Schema & domain errors

- **Input schemas**: Any Standard Schema v1 library that implements Standard JSON Schema v1 (`~standard.jsonSchema.input`, such as Zod 4, Valibot, or ArkType) automatically populates `inputSchema` in `tools/list`. You can also pass an explicit `inputSchema` per tool.
- **Validation & domain errors**: Schema validation failures, `ctx.deny(...)` responses, and thrown errors map cleanly to MCP tool results with `isError: true` so agents can read the message and recover.

## 3. Bearer token security

| State | HTTP response |
| :--- | :--- |
| Token unconfigured / missing env var / missing file | `404 Not Found` (endpoint hidden) |
| Missing or invalid `Authorization: Bearer <token>` | `401 Unauthorized` (`WWW-Authenticate: Bearer`) |
| Valid token (constant-time SHA-256 comparison) | `200 OK` JSON-RPC 2.0 (`202 Accepted` on notifications) |

<Callout title="Works cleanly in --compile binaries" tone="info">
Because `@kayjs/mcp` uses `token: { env: '...' }` or `token: { file: '...' }` at request time, secrets are never baked into your standalone binary and can be rotated on disk without rebuilding.
</Callout>
