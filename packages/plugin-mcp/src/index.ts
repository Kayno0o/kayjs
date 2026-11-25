// @kayjs/mcp — Zero-dependency MCP Streamable HTTP (2025-03-26) plugin for Kay v2.
// Exposes typed Kay v2 server `action()` handlers (and standalone tool handlers) as MCP tools
// over a bearer-authenticated endpoint via `KayPlugin.server`, keeping core free of MCP code.

import type { ActionContext, InferOutput, KayPlugin, RequestContext, ServerAction, StandardSchemaV1 } from '@kayjs/kay/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { CompactSchemaOptions, JsonSchemaObject } from './schema'
import { definePlugin, formatSchemaIssues, nodeEnv, validateSchema } from '@kayjs/kay/server'
import { isPlainRecord, isStandardSchema, normalizeObjectSchema, schemaToJsonSchema } from './schema'

export { compactSchema, schemaToJsonSchema } from './schema'
export type { CompactSchemaOptions, JsonSchemaObject } from './schema'

export const MCP_PROTOCOL_VERSION = '2025-03-26'

const DEFAULT_MAX_TOOL_BYTES = 2048

export interface McpToolAnnotations {
  title?: string | undefined
  readOnlyHint?: boolean | undefined
  destructiveHint?: boolean | undefined
  idempotentHint?: boolean | undefined
  openWorldHint?: boolean | undefined
}

export interface McpContentBlock {
  type: 'text'
  text: string
}

export interface McpToolResult {
  content: McpContentBlock[]
  isError?: boolean | undefined
}

export type McpPruneMode = false | 'nullish' | true

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

export interface McpBudgetOptions {
  /** Per-tool byte budget in `tools/list` (default: 2048). */
  maxToolBytes?: number | undefined
  /** Total `instructions` + `tools/list` byte budget (optional). */
  maxTotalBytes?: number | undefined
  /** When true, `kay check` fails with `ctx.error()` on budget overruns instead of warning (default: false). */
  strict?: boolean | undefined
  /** Custom warning sink for dev startup / non-strict `kay check` (default: `console.warn`). */
  onWarn?: ((message: string) => void) | undefined
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
  /** Convenience env var name holding the bearer token (used when `token` is omitted). */
  tokenEnv?: string | undefined
  /** Convenience file path holding the bearer token (used when `token` and `tokenEnv` are omitted). */
  tokenFile?: string | undefined
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

export interface PruneEmptyOptions {
  /** Also drop empty arrays `[]` and empty objects `{}` (default: true). */
  emptyCollections?: boolean | undefined
  /** Also drop empty strings `""` (default: false). */
  emptyStrings?: boolean | undefined
}

export interface CompactListOptions {
  /** Total available items when the returned slice is paginated. */
  total?: number | undefined
  /** Next cursor/offset hint shown in the footer when more items exist. */
  nextCursor?: string | number | null | undefined
  /** Fallback text when the list is empty (default: '(none)'). */
  empty?: string | undefined
}

export interface McpToolFootprint {
  name: string
  chars: number
  bytes: number
  descriptionBytes: number
  schemaBytes: number
  estimatedTokens: number
}

export interface McpFootprint {
  instructionsChars: number
  instructionsBytes: number
  toolsChars: number
  toolsBytes: number
  totalChars: number
  totalBytes: number
  estimatedTokens: number
  tools: McpToolFootprint[]
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

interface ListedTool {
  name: string
  description: string
  inputSchema: JsonSchemaObject
  annotations?: McpToolAnnotations
}

interface ResolvedResource {
  uri: string
  name: string
  description?: string
  mimeType: string
  read: (ctx: RequestContext) => string | Promise<string>
}

interface ResolvedToolEntry {
  name: string
  action?: ServerAction<unknown, unknown> | undefined
  schema: StandardSchemaV1 | undefined
  handler: (input: unknown, ctx: ActionContext) => unknown | Promise<unknown>
  format: ((output: unknown, input: unknown) => unknown) | undefined
  maxOutputChars: number | undefined
  pruneEmpty: McpPruneMode
}

function utf8Bytes(str: string): number {
  return Buffer.byteLength(str, 'utf8')
}

/** Recursively removes `null`/`undefined` (and by default empty `[]`/`{}`) to shrink JSON payloads. */
export function pruneEmpty(value: unknown, options?: PruneEmptyOptions): unknown {
  const dropCollections = options?.emptyCollections ?? true
  const dropStrings = options?.emptyStrings ?? false

  function walk(node: unknown, isRoot: boolean): unknown {
    if (node === null || node === undefined)
      return isRoot ? node : undefined
    if (typeof node === 'string')
      return !isRoot && dropStrings && node.length === 0 ? undefined : node
    if (Array.isArray(node)) {
      const out: unknown[] = []
      for (const item of node) {
        const cleaned = walk(item, false)
        if (cleaned !== undefined)
          out.push(cleaned)
      }
      if (!isRoot && dropCollections && out.length === 0)
        return undefined
      return out
    }
    if (typeof node === 'object') {
      const proto = Object.getPrototypeOf(node)
      if (proto !== Object.prototype && proto !== null)
        return node
      const out: Record<string, unknown> = {}
      let count = 0
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const cleaned = walk(v, false)
        if (cleaned !== undefined) {
          out[k] = cleaned
          count++
        }
      }
      if (!isRoot && dropCollections && count === 0)
        return undefined
      return out
    }
    return node
  }

  return walk(value, true)
}

function formatListFooter(count: number, options?: CompactListOptions): string {
  const parts: string[] = []
  if (options?.total !== undefined && options.total > count)
    parts.push(`${count}/${options.total}`)
  if (options?.nextCursor !== undefined && options.nextCursor !== null && String(options.nextCursor).length > 0)
    parts.push(`next=${options.nextCursor}`)
  return parts.length > 0 ? `\n--- ${parts.join(', ')}` : ''
}

/** Renders items as compact one-line-per-entry text with an optional pagination footer. */
export function formatLines<T>(
  items: readonly T[],
  render: (item: T, index: number) => string,
  options?: CompactListOptions,
): string {
  if (items.length === 0)
    return options?.empty ?? '(none)'
  return items.map(render).join('\n') + formatListFooter(items.length, options)
}

function escapeTsvCell(value: unknown): string {
  if (value === null || value === undefined)
    return ''
  const raw = typeof value === 'string'
    ? value
    : (typeof value === 'object' ? JSON.stringify(value) : String(value))
  return raw.replace(/[\t\r\n]+/g, ' ')
}

/** Renders tabular records as compact TSV (typically 50–65% fewer tokens than JSON object arrays). */
export function formatTable<T extends Record<string, unknown>>(
  rows: readonly T[],
  columns?: readonly (keyof T & string)[],
  options?: CompactListOptions,
): string {
  if (rows.length === 0)
    return options?.empty ?? '(none)'
  const cols: readonly string[] = columns && columns.length > 0
    ? columns
    : Object.keys(rows[0] ?? {})
  if (cols.length === 0)
    return options?.empty ?? '(none)'

  const lines: string[] = [cols.join('\t')]
  for (const row of rows)
    lines.push(cols.map(col => escapeTsvCell(row[col])).join('\t'))
  return lines.join('\n') + formatListFooter(rows.length, options)
}

/** Truncates oversized text outputs cleanly while leaving an actionable recovery hint. */
export function truncateOutput(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars)
    return text
  const reserve = 64
  if (maxChars <= reserve)
    return text.slice(0, maxChars)
  let keep = maxChars - reserve
  let omitted = text.length - keep
  let suffix = `\n…[truncated ${omitted} chars — narrow query or paginate]`
  if (keep + suffix.length > maxChars) {
    keep = Math.max(0, maxChars - suffix.length)
    omitted = text.length - keep
    suffix = `\n…[truncated ${omitted} chars — narrow query or paginate]`
  }
  return text.slice(0, keep) + suffix
}

function applyPrune(value: unknown, mode: McpPruneMode): unknown {
  if (mode === false)
    return value
  if (mode === 'nullish')
    return pruneEmpty(value, { emptyCollections: false })
  return pruneEmpty(value, { emptyCollections: true })
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

function computeFootprint(instructions: string | undefined, listedTools: readonly ListedTool[]): McpFootprint {
  const instructionsText = instructions ?? ''
  const instructionsChars = instructionsText.length
  const instructionsBytes = utf8Bytes(instructionsText)
  const tools: McpToolFootprint[] = []
  let toolsChars = 0
  let toolsBytes = 0

  for (const listed of listedTools) {
    const json = JSON.stringify(listed)
    const chars = json.length
    const bytes = utf8Bytes(json)
    const descriptionBytes = utf8Bytes(listed.description)
    const schemaBytes = utf8Bytes(JSON.stringify(listed.inputSchema))
    toolsChars += chars
    toolsBytes += bytes
    tools.push({
      name: listed.name,
      chars,
      bytes,
      descriptionBytes,
      schemaBytes,
      estimatedTokens: Math.ceil(bytes / 4),
    })
  }

  tools.sort((a, b) => b.bytes - a.bytes)
  const totalChars = instructionsChars + toolsChars
  const totalBytes = instructionsBytes + toolsBytes
  return {
    instructionsChars,
    instructionsBytes,
    toolsChars,
    toolsBytes,
    totalChars,
    totalBytes,
    estimatedTokens: Math.ceil(totalBytes / 4),
    tools,
  }
}

/** Measures the up-front `instructions` + `tools/list` byte/char/token footprint (sorted largest tool first). */
export function inspectMcpFootprint(
  options: Pick<McpOptions, 'instructions' | 'tools' | 'resources' | 'schemas' | 'compactSchemas'>,
): McpFootprint {
  const { listedTools } = buildCatalog(options)
  return computeFootprint(options.instructions, listedTools)
}

function collectBudgetViolations(footprint: McpFootprint, budget: McpBudgetOptions | false | undefined): string[] {
  if (budget === false)
    return []
  const maxToolBytes = budget?.maxToolBytes ?? DEFAULT_MAX_TOOL_BYTES
  const maxTotalBytes = budget?.maxTotalBytes
  const violations: string[] = []

  if (maxToolBytes > 0) {
    for (const tool of footprint.tools) {
      if (tool.bytes > maxToolBytes) {
        violations.push(
          `[@kayjs/mcp] tool "${tool.name}" is ${tool.bytes} B (~${tool.estimatedTokens} tok; desc ${tool.descriptionBytes} B, schema ${tool.schemaBytes} B), exceeding ${maxToolBytes} B budget`,
        )
      }
    }
  }
  if (maxTotalBytes !== undefined && maxTotalBytes > 0 && footprint.totalBytes > maxTotalBytes) {
    violations.push(
      `[@kayjs/mcp] total MCP surface is ${footprint.totalBytes} B (~${footprint.estimatedTokens} tok), exceeding ${maxTotalBytes} B budget`,
    )
  }
  return violations
}

/** Formats an `McpFootprint` report as a compact table for CLI / CI output. */
export function formatMcpFootprint(footprint: McpFootprint, budget?: McpBudgetOptions | false): string {
  const maxToolBytes = budget === false ? undefined : (budget?.maxToolBytes ?? DEFAULT_MAX_TOOL_BYTES)
  const lines = [
    `@kayjs/mcp footprint: ${footprint.totalBytes} B (~${footprint.estimatedTokens} tok) — instructions: ${footprint.instructionsBytes} B, tools: ${footprint.toolsBytes} B (${footprint.tools.length} tools)`,
  ]
  const nameWidth = footprint.tools.reduce((max, t) => Math.max(max, t.name.length), 0)
  for (const t of footprint.tools) {
    const flag = maxToolBytes !== undefined && maxToolBytes > 0 && t.bytes > maxToolBytes
      ? `  [OVER ${maxToolBytes} B]`
      : ''
    lines.push(
      `  ${t.name.padEnd(nameWidth)}  ${String(t.bytes).padStart(6)} B (~${t.estimatedTokens} tok)  desc: ${t.descriptionBytes} B  schema: ${t.schemaBytes} B${flag}`,
    )
  }
  return lines.join('\n')
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

function isMcpToolResult(value: unknown): value is McpToolResult {
  if (typeof value !== 'object' || value === null || !('content' in value))
    return false
  const content = (value as { content: unknown }).content
  return Array.isArray(content) && content.every(
    item => typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string',
  )
}

function formatFieldErrors(fieldErrors: unknown): string {
  if (fieldErrors === null || typeof fieldErrors !== 'object' || Array.isArray(fieldErrors))
    return ''
  return Object.entries(fieldErrors as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && String(v).length > 0)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join('; ')
}

async function formatResponseResult(res: Response, pruneMode: McpPruneMode): Promise<McpToolResult> {
  // 3xx redirects from reused Kay form actions indicate a completed mutation, not a failure.
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location')
    return { content: [{ type: 'text', text: location ? `ok -> ${location}` : 'ok' }] }
  }

  const rawText = await res.text()
  if (!res.ok) {
    let errorMsg = rawText || `${res.status} ${res.statusText}`.trim()
    if (rawText.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(rawText) as { error?: unknown, message?: unknown, fieldErrors?: unknown }
        const base = typeof parsed.error === 'string' && parsed.error.length > 0
          ? parsed.error
          : (typeof parsed.message === 'string' && parsed.message.length > 0 ? parsed.message : '')
        const fields = formatFieldErrors(parsed.fieldErrors)
        if (base && fields)
          errorMsg = `${base} (${fields})`
        else if (base)
          errorMsg = base
        else if (fields)
          errorMsg = fields
      }
      catch {
        // Keep rawText
      }
    }
    return { content: [{ type: 'text', text: errorMsg }], isError: true }
  }

  if (rawText.length === 0 && res.status === 204)
    return { content: [{ type: 'text', text: 'ok' }] }

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('json')) {
    try {
      const parsed = JSON.parse(rawText) as unknown
      return { content: [{ type: 'text', text: JSON.stringify(applyPrune(parsed, pruneMode)) }] }
    }
    catch {
      // Keep rawText when body is not valid JSON
    }
  }
  return { content: [{ type: 'text', text: rawText }] }
}

function applyOutputBudget(result: McpToolResult, maxChars: number | undefined): McpToolResult {
  if (maxChars === undefined || maxChars <= 0)
    return result
  let remaining = maxChars
  const nextContent: McpContentBlock[] = []
  for (const block of result.content) {
    if (remaining <= 0)
      break
    const text = truncateOutput(block.text, remaining)
    remaining -= text.length
    nextContent.push({ type: 'text', text })
  }
  return result.isError !== undefined
    ? { content: nextContent, isError: result.isError }
    : { content: nextContent }
}

const MAX_BATCH_SIZE = 50

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
  const hasResources = resourceMap.size > 0
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

  const availableNamesHint = toolMap.size > 0 && toolMap.size <= 12
    ? ` (available: ${[...toolMap.keys()].join(', ')})`
    : ''

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

  async function finalizeValue(value: unknown, pruneMode: McpPruneMode): Promise<McpToolResult> {
    if (value instanceof Response)
      return await formatResponseResult(value, pruneMode)
    if (isMcpToolResult(value))
      return value
    if (typeof value === 'string')
      return { content: [{ type: 'text', text: value }] }
    if (value === undefined)
      return { content: [{ type: 'text', text: 'ok' }] }
    return { content: [{ type: 'text', text: JSON.stringify(applyPrune(value, pruneMode)) }] }
  }

  let serverApi: Parameters<NonNullable<KayPlugin['server']>>[0] | undefined

  async function callTool(name: string, args: unknown, ctx: RequestContext): Promise<McpToolResult> {
    const tool = toolMap.get(name)
    if (tool === undefined)
      throw Object.assign(new Error(`Unknown tool: ${name}${availableNamesHint}`), { rpcCode: -32602 })

    let input: unknown = args ?? {}
    if (tool.schema !== undefined) {
      const checked = await validateSchema(tool.schema, input)
      if (!checked.ok) {
        return {
          content: [{ type: 'text', text: `Invalid arguments: ${formatSchemaIssues(checked.issues)}` }],
          isError: true,
        }
      }
      input = checked.value
    }

    try {
      let rawResult: unknown
      if (tool.action !== undefined && serverApi !== undefined) {
        const invoked = await serverApi.invokeAction(tool.action, input, ctx)
        if (!invoked.ok) {
          const fields = formatFieldErrors(invoked.fieldErrors)
          const msg = fields ? `${invoked.error} (${fields})` : invoked.error
          return applyOutputBudget({
            content: [{ type: 'text', text: msg }],
            isError: true,
          }, tool.maxOutputChars)
        }
        rawResult = invoked.data
      }
      else {
        rawResult = await tool.handler(input, ctx)
      }
      let mcpResult: McpToolResult
      if (rawResult instanceof Response) {
        mcpResult = await formatResponseResult(rawResult, tool.pruneEmpty)
      }
      else {
        const formatted = tool.format !== undefined
          ? tool.format(rawResult, input)
          : (options.formatResult !== undefined ? options.formatResult(rawResult, name, input) : rawResult)
        mcpResult = await finalizeValue(formatted, tool.pruneEmpty)
      }
      return applyOutputBudget(mcpResult, tool.maxOutputChars)
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
      return applyOutputBudget({
        content: [{ type: 'text', text: message }],
        isError: true,
      }, tool.maxOutputChars)
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
            capabilities: {
              tools: { listChanged: false },
              ...(hasResources ? { resources: { subscribe: false, listChanged: false } } : {}),
            },
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
            tools: listedTools,
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

      case 'resources/list': {
        if (!hasResources)
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } }
        return {
          jsonrpc: '2.0',
          id,
          result: { resources: listedResources },
        }
      }

      case 'resources/read': {
        if (!hasResources)
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } }
        const uri = typeof req.params?.uri === 'string' ? req.params.uri : undefined
        if (uri === undefined)
          return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing resource uri' } }
        const resource = resourceMap.get(uri)
        if (resource === undefined)
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown resource: ${uri}` } }
        try {
          const text = await resource.read(ctx)
          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }],
            },
          }
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { jsonrpc: '2.0', id, error: { code: -32603, message } }
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
      serverApi = api
      if (api.dev || nodeEnv() !== 'production') {
        for (const msg of collectBudgetViolations(footprint, options.budget))
          warnSink(msg)
      }

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
          if (payload.length === 0 || payload.length > MAX_BATCH_SIZE) {
            return Response.json(
              { jsonrpc: '2.0', id: null, error: { code: -32600, message: payload.length === 0 ? 'Invalid Request' : `Batch size exceeds limit (${MAX_BATCH_SIZE})` } },
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
