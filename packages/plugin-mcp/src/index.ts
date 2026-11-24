// @kayjs/mcp — Zero-dependency MCP Streamable HTTP (2025-03-26) plugin for Kay v2.
// Exposes typed Kay v2 server `action()` handlers (and standalone tool handlers) as MCP tools
// over a bearer-authenticated endpoint via `KayPlugin.server`, keeping core free of MCP code.

import type { ActionContext, InferOutput, KayPlugin, RequestContext, ServerAction, StandardSchemaIssue, StandardSchemaV1 } from 'kay/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { definePlugin } from 'kay/server'

export const MCP_PROTOCOL_VERSION = '2025-03-26'

export interface JsonSchemaObject {
  type?: string | undefined
  properties?: Record<string, unknown> | undefined
  required?: string[] | undefined
  additionalProperties?: boolean | Record<string, unknown> | undefined
  [key: string]: unknown
}

export interface McpContentBlock {
  type: 'text'
  text: string
}

export interface McpToolResult {
  content: McpContentBlock[]
  isError?: boolean | undefined
}

export interface McpActionTool<Input = unknown, Output = unknown> {
  /** Existing Kay v2 `action()` handler to expose as an MCP tool. */
  action: ServerAction<Input, Output>
  /** Human/agent-facing tool description shown in `tools/list`. */
  description: string
  /** Optional explicit JSON Schema override (otherwise derived from Standard JSON Schema v1). */
  inputSchema?: JsonSchemaObject | undefined
}

export interface McpHandlerTool<S extends StandardSchemaV1 = StandardSchemaV1> {
  description: string
  schema?: S | undefined
  inputSchema?: JsonSchemaObject | undefined
  handler: (input: InferOutput<S>, ctx: ActionContext) => unknown | Promise<unknown>
}

export type McpTool = McpActionTool<any, any> | McpHandlerTool<any>

export type McpTokenSource =
  | string
  | { env: string }
  | { file: string }
  | (() => string | undefined | Promise<string | undefined>)

export interface McpOptions {
  /** Server name reported in `initialize` `serverInfo.name` (default: 'kay-mcp'). */
  name?: string | undefined
  /** Server version reported in `initialize` `serverInfo.version` (default: '1.0.0'). */
  version?: string | undefined
  /** Optional server-level instructions returned in `initialize`. */
  instructions?: string | undefined
  /** HTTP endpoint path (default: '/mcp/tools'). */
  path?: string | undefined
  /** Bearer token source: inline string, `{ env }`, `{ file }`, or resolver function. */
  token?: McpTokenSource | undefined
  /** Convenience env var name holding the bearer token (used when `token` is omitted). */
  tokenEnv?: string | undefined
  /** Convenience file path holding the bearer token (used when `token` and `tokenEnv` are omitted). */
  tokenFile?: string | undefined
  /** Map of MCP tool names to Kay `action()` or handler definitions. */
  tools: Record<string, McpTool>
  /** Optional domain-error formatter for thrown errors (defaults to `err.message`). */
  mapError?: ((error: unknown) => string | { message: string } | undefined) | undefined
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null | undefined
  method: string
  params?: Record<string, unknown> | undefined
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number, message: string, data?: unknown }
}

interface StandardJsonSchemaCapable {
  '~standard'?: {
    jsonSchema?: {
      input?: (opts: { target: string }) => Record<string, unknown>
    } | undefined
  } | undefined
  toJSONSchema?: (() => Record<string, unknown>) | undefined
  jsonSchema?: Record<string, unknown> | undefined
}

const DEFAULT_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {},
  additionalProperties: true,
}

function normalizeObjectSchema(raw: Record<string, unknown> | undefined): JsonSchemaObject {
  if (!raw || typeof raw !== 'object')
    return { ...DEFAULT_INPUT_SCHEMA }
  const copy: JsonSchemaObject = { ...raw }
  if (copy.type === undefined)
    copy.type = 'object'
  if (copy.type === 'object' && copy.properties === undefined)
    copy.properties = {}
  return copy
}

/** Extracts an MCP-compatible JSON Schema object from a Standard Schema (Zod 4, Valibot, ArkType, etc.). */
export function schemaToJsonSchema(schema: StandardSchemaV1 | undefined): JsonSchemaObject {
  if (schema === undefined)
    return { ...DEFAULT_INPUT_SCHEMA }

  const candidate = schema as unknown as StandardJsonSchemaCapable
  const stdJson = candidate['~standard']?.jsonSchema
  if (stdJson && typeof stdJson.input === 'function') {
    for (const target of ['draft-2020-12', 'draft-07']) {
      try {
        const out = stdJson.input({ target })
        if (out && typeof out === 'object')
          return normalizeObjectSchema(out)
      }
      catch {
        // Try next JSON Schema draft target
      }
    }
  }

  if (typeof candidate.toJSONSchema === 'function') {
    try {
      const out = candidate.toJSONSchema()
      if (out && typeof out === 'object')
        return normalizeObjectSchema(out)
    }
    catch {
      // Fall through to default object schema
    }
  }

  if (candidate.jsonSchema && typeof candidate.jsonSchema === 'object')
    return normalizeObjectSchema(candidate.jsonSchema)

  return { ...DEFAULT_INPUT_SCHEMA }
}

function readTokenFile(filePath: string): string | undefined {
  if (!existsSync(filePath))
    return undefined
  try {
    const raw = readFileSync(filePath, 'utf8').trim()
    return raw.length > 0 ? raw : undefined
  }
  catch {
    return undefined
  }
}

async function resolveConfiguredToken(options: McpOptions): Promise<string | undefined> {
  const src = options.token
  if (typeof src === 'function') {
    const val = (await src())?.trim()
    return val && val.length > 0 ? val : undefined
  }
  if (typeof src === 'string') {
    const val = src.trim()
    return val.length > 0 ? val : undefined
  }
  if (src !== undefined && typeof src === 'object') {
    if ('env' in src) {
      const val = process.env[src.env]?.trim()
      return val && val.length > 0 ? val : undefined
    }
    if ('file' in src)
      return readTokenFile(src.file)
  }
  if (options.tokenEnv !== undefined) {
    const val = process.env[options.tokenEnv]?.trim()
    return val && val.length > 0 ? val : undefined
  }
  if (options.tokenFile !== undefined)
    return readTokenFile(options.tokenFile)
  return undefined
}

function tokensEqual(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization')
  if (header === null)
    return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match)
    return undefined
  const token = match[1]?.trim()
  return token && token.length > 0 ? token : undefined
}

function formatSchemaIssues(issues: ReadonlyArray<StandardSchemaIssue>): string {
  return issues
    .map((issue) => {
      const path = issue.path && issue.path.length > 0
        ? issue.path.map(seg => (typeof seg === 'object' && seg !== null && 'key' in seg ? String(seg.key) : String(seg))).join('.')
        : ''
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('; ')
}

function isMcpToolResult(value: unknown): value is McpToolResult {
  if (typeof value !== 'object' || value === null || !('content' in value))
    return false
  const content = (value as { content: unknown }).content
  return Array.isArray(content) && content.every(
    item => typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string',
  )
}

async function formatResponseResult(res: Response): Promise<McpToolResult> {
  const rawText = await res.text()
  if (!res.ok) {
    let errorMsg = rawText || `${res.status} ${res.statusText}`.trim()
    if (rawText.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawText) as { error?: unknown, message?: unknown }
        if (typeof parsed.error === 'string' && parsed.error.length > 0)
          errorMsg = parsed.error
        else if (typeof parsed.message === 'string' && parsed.message.length > 0)
          errorMsg = parsed.message
      }
      catch {
        // Keep rawText
      }
    }
    return { content: [{ type: 'text', text: errorMsg }], isError: true }
  }
  return { content: [{ type: 'text', text: rawText }] }
}

function makeActionContext(ctx: RequestContext): ActionContext {
  return {
    request: ctx.request,
    url: ctx.url,
    params: ctx.params,
    cookies: ctx.cookies,
    locals: ctx.locals,
    redirect: ctx.redirect,
    deny(status, message, fieldErrors) {
      return Response.json(
        { ok: false, status, error: message, ...(fieldErrors !== undefined ? { fieldErrors } : {}) },
        { status },
      )
    },
  }
}

function isActionTool(tool: McpTool): tool is McpActionTool {
  return 'action' in tool
}

export function mcp(options: McpOptions): KayPlugin {
  const rawPath = options.path ?? '/mcp/tools'
  const endpoint = rawPath === '/' ? '/' : `/${rawPath.replace(/^\/+|\/+$/g, '')}`
  const serverName = options.name ?? 'kay-mcp'
  const serverVersion = options.version ?? '1.0.0'

  const toolEntries = Object.entries(options.tools)
  const toolMap = new Map<string, {
    name: string
    description: string
    schema: StandardSchemaV1 | undefined
    inputSchema: JsonSchemaObject
    handler: (input: unknown, ctx: ActionContext) => unknown | Promise<unknown>
  }>()

  for (const [name, def] of toolEntries) {
    const schema = isActionTool(def) ? def.action.schema : def.schema
    const handler = isActionTool(def)
      ? ((input: unknown, ctx: ActionContext) => def.action.handler(input as never, ctx))
      : def.handler
    const inputSchema = def.inputSchema !== undefined
      ? normalizeObjectSchema(def.inputSchema)
      : schemaToJsonSchema(schema)
    toolMap.set(name, {
      name,
      description: def.description,
      schema,
      inputSchema,
      handler,
    })
  }

  async function authorize(request: Request): Promise<Response | undefined> {
    const configured = await resolveConfiguredToken(options)
    if (configured === undefined)
      return new Response('Not Found', { status: 404 })

    const provided = extractBearerToken(request)
    if (provided === undefined || !tokensEqual(provided, configured)) {
      return Response.json(
        { error: 'Unauthorized' },
        { status: 401, headers: { 'www-authenticate': 'Bearer' } },
      )
    }
    return undefined
  }

  async function callTool(name: string, args: unknown, ctx: RequestContext): Promise<McpToolResult> {
    const tool = toolMap.get(name)
    if (tool === undefined)
      throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 })

    let input: unknown = args ?? {}
    if (tool.schema !== undefined) {
      const checked = await tool.schema['~standard'].validate(input)
      if (checked.issues && checked.issues.length > 0) {
        return {
          content: [{ type: 'text', text: `Invalid arguments: ${formatSchemaIssues(checked.issues)}` }],
          isError: true,
        }
      }
      input = (checked as { value: unknown }).value
    }

    const actionCtx = makeActionContext(ctx)
    try {
      const result = await tool.handler(input, actionCtx)
      if (result instanceof Response)
        return await formatResponseResult(result)
      if (isMcpToolResult(result))
        return result
      if (typeof result === 'string')
        return { content: [{ type: 'text', text: result }] }
      if (result === undefined)
        return { content: [{ type: 'text', text: 'ok' }] }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
    catch (err) {
      const mapped = options.mapError?.(err)
      const message = typeof mapped === 'string'
        ? mapped
        : mapped && typeof mapped.message === 'string'
          ? mapped.message
          : err instanceof Error
            ? err.message
            : String(err)
      return {
        content: [{ type: 'text', text: message }],
        isError: true,
      }
    }
  }

  async function handleRpcMessage(msg: unknown, ctx: RequestContext): Promise<JsonRpcResponse | null> {
    if (typeof msg !== 'object' || msg === null)
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }

    const req = msg as Partial<JsonRpcRequest>
    const hasId = 'id' in req && req.id !== undefined
    const id = hasId ? (req.id ?? null) : null

    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string')
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } }

    // JSON-RPC notifications (no `id`) receive no response payload (HTTP 202)
    if (!hasId)
      return null

    switch (req.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: serverName, version: serverVersion },
            ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
          },
        }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [...toolMap.values()].map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        }

      case 'tools/call': {
        const params = req.params
        const toolName = typeof params?.name === 'string' ? params.name : undefined
        if (toolName === undefined)
          return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tool name' } }
        try {
          const toolResult = await callTool(toolName, params?.arguments, ctx)
          return { jsonrpc: '2.0', id, result: toolResult }
        }
        catch (err) {
          const rpcCode = (err as { rpcCode?: number }).rpcCode ?? -32603
          const message = err instanceof Error ? err.message : String(err)
          return { jsonrpc: '2.0', id, error: { code: rpcCode, message } }
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        }
    }
  }

  return definePlugin({
    name: '@kayjs/mcp',
    server(api) {
      api.route('POST', endpoint, async (ctx) => {
        const denied = await authorize(ctx.request)
        if (denied !== undefined)
          return denied

        let payload: unknown
        try {
          payload = await ctx.request.json()
        }
        catch {
          return Response.json(
            { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
            { status: 400 },
          )
        }

        if (Array.isArray(payload)) {
          if (payload.length === 0) {
            return Response.json(
              { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
              { status: 400 },
            )
          }
          const responses: JsonRpcResponse[] = []
          for (const item of payload) {
            const res = await handleRpcMessage(item, ctx)
            if (res !== null)
              responses.push(res)
          }
          if (responses.length === 0)
            return new Response(null, { status: 202 })
          return Response.json(responses, { status: 200 })
        }

        const single = await handleRpcMessage(payload, ctx)
        if (single === null)
          return new Response(null, { status: 202 })
        const status = single.error?.code === -32600 ? 400 : 200
        return Response.json(single, { status })
      })

      api.route('GET', endpoint, async (ctx) => {
        const denied = await authorize(ctx.request)
        if (denied !== undefined)
          return denied
        return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST, DELETE' } })
      })

      api.route('DELETE', endpoint, async (ctx) => {
        const denied = await authorize(ctx.request)
        if (denied !== undefined)
          return denied
        return new Response(null, { status: 204 })
      })
    },
  })
}
