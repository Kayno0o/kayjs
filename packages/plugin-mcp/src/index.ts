// @kayjs/mcp — Zero-dependency MCP Streamable HTTP (2025-03-26) plugin for Kay v2.
// Exposes typed Kay v2 server `action()` handlers (and standalone tool handlers) as MCP tools
// over a bearer-authenticated endpoint via `KayPlugin.server`, keeping core free of MCP code.

import type { ActionContext, InferOutput, KayPlugin, RequestContext, ServerAction, ServerPluginAPI, StandardSchemaV1 } from '@kayjs/kay/server'
import type { McpBudgetOptions, McpFootprint } from './footprint'
import type { McpPruneMode, McpToolResult } from './format'
import type { ListedTool, McpToolAnnotations, ResolvedResource, ResolvedToolEntry } from './rpc'
import type { CompactSchemaOptions, JsonSchemaObject } from './schema'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { definePlugin, nodeEnv } from '@kayjs/kay/server'
import { collectBudgetViolations, computeFootprint, formatMcpFootprint } from './footprint'
import { createRpcDispatcher } from './rpc'
import { isPlainRecord, isStandardSchema, normalizeObjectSchema, schemaToJsonSchema } from './schema'

export { formatMcpFootprint } from './footprint'
export type { McpBudgetOptions, McpFootprint, McpToolFootprint } from './footprint'
export { formatLines, formatTable, pruneEmpty, truncateOutput } from './format'
export type { CompactListOptions, McpContentBlock, McpPruneMode, McpToolResult, PruneEmptyOptions } from './format'
export { MAX_BATCH_SIZE, MCP_PROTOCOL_VERSION } from './rpc'
export type { McpToolAnnotations } from './rpc'
export { compactSchema, schemaToJsonSchema } from './schema'
export type { CompactSchemaOptions, JsonSchemaObject } from './schema'

export interface McpResource {
  /** Display name shown in `resources/list` (defaults to the resource URI/key). */
  name?: string | undefined
  /** Short one-line description shown in `resources/list`. */
  description?: string | undefined
  /** MIME type returned on `resources/read` (default: 'text/plain'). */
  mimeType?: string | undefined
  /** Static text or lazy reader invoked on `resources/read`. */
  read: string | ((ctx: RequestContext) => string | Promise<string>)
}

export interface McpActionTool<Input = unknown, Output = unknown> {
  /** Existing Kay v2 `action()` handler to expose as an MCP tool. */
  action: ServerAction<Input, Output>
  handler?: never
  /** Human/agent-facing tool description shown in `tools/list`. */
  description: string
  /** Optional explicit JSON Schema override (otherwise derived from Standard JSON Schema v1). */
  inputSchema?: JsonSchemaObject | undefined
  /** Reference a shared schema in `options.schemas` to emit a tiny stub in `tools/list` while keeping full server-side validation. */
  schemaRef?: string | undefined
  /** Optional MCP 2025-03-26 tool annotations (only emitted when provided). */
  annotations?: McpToolAnnotations | undefined
  /** Optional token-lean formatter transforming the action's output before sending to the agent. */
  format?: ((output: Output, input: Input) => unknown) | undefined
  /** Per-tool character cap on text output before truncation with a recovery hint. */
  maxOutputChars?: number | undefined
  /** Per-tool override for stripping null/undefined/empty values from JSON outputs. */
  pruneEmpty?: McpPruneMode | undefined
}

export interface McpHandlerTool<S extends StandardSchemaV1 | undefined = undefined, R = unknown> {
  action?: never
  description: string
  schema?: S
  inputSchema?: JsonSchemaObject | undefined
  /** Reference a shared schema in `options.schemas` to emit a tiny stub in `tools/list` while keeping full server-side validation. */
  schemaRef?: string | undefined
  /** Optional MCP 2025-03-26 tool annotations (only emitted when provided). */
  annotations?: McpToolAnnotations | undefined
  handler: (input: [S] extends [StandardSchemaV1] ? InferOutput<S> : Record<string, unknown>, ctx: ActionContext) => R | Promise<R>
  /** Optional token-lean formatter transforming the handler's output before sending to the agent. */
  format?: ((output: Awaited<R>, input: [S] extends [StandardSchemaV1] ? InferOutput<S> : Record<string, unknown>) => unknown) | undefined
  /** Per-tool character cap on text output before truncation with a recovery hint. */
  maxOutputChars?: number | undefined
  /** Per-tool override for stripping null/undefined/empty values from JSON outputs. */
  pruneEmpty?: McpPruneMode | undefined
}

/** Variance-safe erased action tool shape (carries no `any`). */
export interface ErasedMcpActionTool {
  action: ServerAction<never, unknown>
  handler?: never
  description: string
  inputSchema?: JsonSchemaObject | undefined
  schemaRef?: string | undefined
  annotations?: McpToolAnnotations | undefined
  format?: ((output: never, input: never) => unknown) | undefined
  maxOutputChars?: number | undefined
  pruneEmpty?: McpPruneMode | undefined
}

/** Variance-safe erased handler tool shape (carries no `any`). */
export interface ErasedMcpHandlerTool {
  action?: never
  description: string
  schema?: StandardSchemaV1 | undefined
  inputSchema?: JsonSchemaObject | undefined
  schemaRef?: string | undefined
  annotations?: McpToolAnnotations | undefined
  handler: (input: never, ctx: ActionContext) => unknown | Promise<unknown>
  format?: ((output: never, input: never) => unknown) | undefined
  maxOutputChars?: number | undefined
  pruneEmpty?: McpPruneMode | undefined
}

export type McpTool = ErasedMcpActionTool | ErasedMcpHandlerTool

type ActionInput<A> = A extends ServerAction<infer I, unknown> ? I : never
type ActionOutput<A> = A extends ServerAction<never, infer O> ? O : unknown

type McpToolEntry<Spec> =
  | {
      action: Spec & ServerAction<never, unknown>
      handler?: never
      description: string
      inputSchema?: JsonSchemaObject | undefined
      schemaRef?: string | undefined
      annotations?: McpToolAnnotations | undefined
      format?: ((output: ActionOutput<Spec>, input: ActionInput<Spec>) => unknown) | undefined
      maxOutputChars?: number | undefined
      pruneEmpty?: McpPruneMode | undefined
    }
  | {
      action?: never
      description: string
      schema?: Spec & (StandardSchemaV1 | undefined)
      inputSchema?: JsonSchemaObject | undefined
      schemaRef?: string | undefined
      annotations?: McpToolAnnotations | undefined
      handler: (input: [Spec] extends [StandardSchemaV1] ? InferOutput<Spec> : Record<string, unknown>, ctx: ActionContext) => unknown | Promise<unknown>
      format?: ((output: never, input: [Spec] extends [StandardSchemaV1] ? InferOutput<Spec> : Record<string, unknown>) => unknown) | undefined
      maxOutputChars?: number | undefined
      pruneEmpty?: McpPruneMode | undefined
    }

export type McpToolsRecord<T extends Record<string, unknown>> = {
  [K in keyof T]: McpToolEntry<T[K]>
}

/** Preserves strict `Input`/`Output` inference for `format` and `handler` callbacks inside `mcp({ tools })`. */
export function mcpTool<Input, Output>(tool: McpActionTool<Input, Output>): McpActionTool<Input, Output>
export function mcpTool<S extends StandardSchemaV1, R = unknown>(tool: McpHandlerTool<S, R> & { schema: S }): McpHandlerTool<S, R>
export function mcpTool<R = unknown>(tool: McpHandlerTool<undefined, R> & { schema?: undefined }): McpHandlerTool<undefined, R>
export function mcpTool(tool: McpTool): McpTool {
  return tool
}

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
  /** Map of MCP tool names to Kay `action()` or handler definitions. */
  tools: Record<string, McpTool>
  /** Optional on-demand MCP resources exposed via `resources/list` and `resources/read`. */
  resources?: Record<string, McpResource> | undefined
  /** Shared schemas exposed on demand via `describe_schema` tool and `kay://schemas/<name>` resources for tools using `schemaRef`. */
  schemas?: Record<string, StandardSchemaV1 | JsonSchemaObject> | undefined
  /** Optional domain-error formatter for thrown errors (defaults to `err.message`). */
  mapError?: ((error: unknown) => string | { message: string } | undefined) | undefined
  /** Strip JSON Schema boilerplate, form-coercion unions, `x-*` keys, and homogeneous records in `tools/list` (default: true). */
  compactSchemas?: boolean | CompactSchemaOptions | undefined
  /** Strip `null`/`undefined` (`'nullish'`) or also empty `[]`/`{}` (`true`) from JSON tool outputs (default: false). */
  pruneEmpty?: McpPruneMode | undefined
  /** Maximum characters per tool call output before truncating with a hint (default: unlimited). */
  maxOutputChars?: number | undefined
  /** Optional server-wide fallback formatter used when a tool does not define its own `format`. */
  formatResult?: ((output: unknown, toolName: string, input: unknown) => unknown) | undefined
  /** Tool & catalog byte budget checked in dev startup and `kay check` (default: `{ maxToolBytes: 2048 }`; `false` disables). */
  budget?: McpBudgetOptions | false | undefined
}

function cleanAnnotations(annotations: McpToolAnnotations | undefined): McpToolAnnotations | undefined {
  if (annotations === undefined)
    return undefined
  const out: McpToolAnnotations = {}
  let hasAny = false
  if (annotations.title !== undefined) {
    out.title = annotations.title
    hasAny = true
  }
  if (annotations.readOnlyHint !== undefined) {
    out.readOnlyHint = annotations.readOnlyHint
    hasAny = true
  }
  if (annotations.destructiveHint !== undefined) {
    out.destructiveHint = annotations.destructiveHint
    hasAny = true
  }
  if (annotations.idempotentHint !== undefined) {
    out.idempotentHint = annotations.idempotentHint
    hasAny = true
  }
  if (annotations.openWorldHint !== undefined) {
    out.openWorldHint = annotations.openWorldHint
    hasAny = true
  }
  return hasAny ? out : undefined
}

function isActionTool(tool: McpTool): tool is ErasedMcpActionTool {
  return 'action' in tool
}

function buildCatalog(
  options: Pick<McpOptions, 'tools' | 'resources' | 'schemas' | 'compactSchemas' | 'maxOutputChars' | 'pruneEmpty'>,
): {
  listedTools: ListedTool[]
  toolMap: Map<string, ResolvedToolEntry>
  resourceMap: Map<string, ResolvedResource>
} {
  const compact = options.compactSchemas ?? true
  const defaultPrune: McpPruneMode = options.pruneEmpty ?? false

  const sharedJsonSchemas = new Map<string, string>()
  const sharedValidators = new Map<string, StandardSchemaV1>()
  const resourceMap = new Map<string, ResolvedResource>()

  if (options.resources !== undefined) {
    for (const [uri, res] of Object.entries(options.resources)) {
      const reader = typeof res.read === 'function' ? res.read : () => res.read as string
      resourceMap.set(uri, {
        uri,
        name: res.name ?? uri,
        ...(res.description !== undefined ? { description: res.description } : {}),
        mimeType: res.mimeType ?? 'text/plain',
        read: reader,
      })
    }
  }

  if (options.schemas !== undefined) {
    for (const [name, def] of Object.entries(options.schemas)) {
      const jsonSchema = isStandardSchema(def)
        ? schemaToJsonSchema(def, { compact })
        : normalizeObjectSchema(def, compact)
      if (isStandardSchema(def))
        sharedValidators.set(name, def)
      const serialized = JSON.stringify(jsonSchema)
      sharedJsonSchemas.set(name, serialized)
      const uri = `kay://schemas/${name}`
      if (!resourceMap.has(uri)) {
        resourceMap.set(uri, {
          uri,
          name: `schema:${name}`,
          description: `JSON Schema for "${name}".`,
          mimeType: 'application/json',
          read: () => serialized,
        })
      }
    }
  }

  const listedTools: ListedTool[] = []
  const toolMap = new Map<string, ResolvedToolEntry>()

  for (const [name, def] of Object.entries(options.tools)) {
    const rawSchema = isActionTool(def) ? def.action.schema : def.schema
    const schema = rawSchema ?? (def.schemaRef !== undefined ? sharedValidators.get(def.schemaRef) : undefined)
    const handler = isActionTool(def)
      ? ((input: unknown, ctx: ActionContext) => def.action.handler(input as never, ctx))
      : ((input: unknown, ctx: ActionContext) => def.handler(input as never, ctx))

    let inputSchema: JsonSchemaObject
    if (def.inputSchema !== undefined) {
      inputSchema = normalizeObjectSchema(def.inputSchema, compact)
    }
    else if (def.schemaRef !== undefined && sharedJsonSchemas.has(def.schemaRef)) {
      inputSchema = {
        type: 'object',
        description: `Matches schema "${def.schemaRef}" (call describe_schema or read kay://schemas/${def.schemaRef}).`,
      }
    }
    else {
      inputSchema = schemaToJsonSchema(schema, { compact })
    }

    const annotations = cleanAnnotations(def.annotations)
    listedTools.push({
      name,
      description: def.description,
      inputSchema,
      ...(annotations !== undefined ? { annotations } : {}),
    })

    toolMap.set(name, {
      name,
      action: isActionTool(def) ? def.action as ServerAction<unknown, unknown> : undefined,
      schema,
      handler,
      format: def.format as ((output: unknown, input: unknown) => unknown) | undefined,
      maxOutputChars: def.maxOutputChars ?? options.maxOutputChars,
      pruneEmpty: def.pruneEmpty !== undefined ? def.pruneEmpty : defaultPrune,
    })
  }

  // Auto-register a tiny `describe_schema` lookup tool when `options.schemas` is provided.
  if (sharedJsonSchemas.size > 0 && !toolMap.has('describe_schema')) {
    const schemaNames = [...sharedJsonSchemas.keys()]
    const inputSchema: JsonSchemaObject = {
      type: 'object',
      properties: { name: { type: 'string', enum: schemaNames } },
      required: ['name'],
    }
    const annotations: McpToolAnnotations = { readOnlyHint: true, idempotentHint: true }
    listedTools.push({
      name: 'describe_schema',
      description: 'Return full JSON Schema for a shared schema name.',
      inputSchema,
      annotations,
    })
    toolMap.set('describe_schema', {
      name: 'describe_schema',
      schema: undefined,
      handler(input) {
        const key = isPlainRecord(input) && typeof input.name === 'string' ? input.name : ''
        const found = sharedJsonSchemas.get(key)
        if (found === undefined) {
          return {
            content: [{ type: 'text', text: `Unknown schema "${key}" (available: ${schemaNames.join(', ')})` }],
            isError: true,
          } satisfies McpToolResult
        }
        return found
      },
      format: undefined,
      maxOutputChars: options.maxOutputChars,
      pruneEmpty: false,
    })
  }

  return { listedTools, toolMap, resourceMap }
}

/** Measures the up-front `instructions` + `tools/list` byte/char/token footprint (sorted largest tool first). */
export function inspectMcpFootprint(
  options: Pick<McpOptions, 'instructions' | 'tools' | 'resources' | 'schemas' | 'compactSchemas'>,
): McpFootprint {
  const { listedTools } = buildCatalog(options)
  return computeFootprint(options.instructions, listedTools)
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

async function resolveToken(src: McpTokenSource | undefined): Promise<string | undefined> {
  if (src === undefined)
    return undefined
  if (typeof src === 'function') {
    const val = (await src())?.trim()
    return val && val.length > 0 ? val : undefined
  }
  if (typeof src === 'string') {
    const val = src.trim()
    return val.length > 0 ? val : undefined
  }
  if ('env' in src) {
    const val = process.env[src.env]?.trim()
    return val && val.length > 0 ? val : undefined
  }
  if ('file' in src)
    return readTokenFile(src.file)
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

export function mcp<T extends Record<string, unknown>>(
  options: Omit<McpOptions, 'tools'> & { tools: McpToolsRecord<T> },
): KayPlugin
export function mcp(options: McpOptions): KayPlugin
export function mcp(options: McpOptions): KayPlugin {
  const rawPath = options.path ?? '/mcp/tools'
  const endpoint = rawPath === '/' ? '/' : `/${rawPath.replace(/^\/+|\/+$/g, '')}`
  const serverName = options.name ?? 'kay-mcp'
  const serverVersion = options.version ?? '1.0.0'

  const { listedTools, toolMap, resourceMap } = buildCatalog(options)
  const listedResources = [...resourceMap.values()].map(r => ({
    uri: r.uri,
    name: r.name,
    ...(r.description !== undefined ? { description: r.description } : {}),
    mimeType: r.mimeType,
  }))

  const footprint = computeFootprint(options.instructions, listedTools)
  const warnSink = (options.budget !== false && options.budget?.onWarn)
    ? options.budget.onWarn
    : (msg: string) => console.warn(msg)

  let serverApi: ServerPluginAPI | undefined

  const rpc = createRpcDispatcher({
    serverName,
    serverVersion,
    instructions: options.instructions,
    listedTools,
    toolMap,
    resourceMap,
    listedResources,
    formatResult: options.formatResult,
    mapError: options.mapError,
    getServerApi: () => serverApi,
  })

  async function authorize(request: Request): Promise<Response | undefined> {
    const configured = await resolveToken(options.token)
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

  return definePlugin({
    name: '@kayjs/mcp',

    server(api) {
      serverApi = api
      if (api.dev || nodeEnv() !== 'production') {
        for (const msg of collectBudgetViolations(footprint, options.budget))
          warnSink(msg)
      }

      api.route('POST', endpoint, async (ctx) => {
        const denied = await authorize(ctx.request)
        if (denied !== undefined)
          return denied
        return rpc.handlePost(ctx)
      }, { csrf: false })

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
      }, { csrf: false })
    },

    check(ctx) {
      const violations = collectBudgetViolations(footprint, options.budget)
      const strict = options.budget !== false && options.budget?.strict === true
      for (const msg of violations) {
        if (strict)
          ctx.error(msg)
        else
          warnSink(msg)
      }
    },

    commands: {
      'mcp-footprint': () => {
        console.log(formatMcpFootprint(footprint, options.budget))
      },
    },
  })
}
