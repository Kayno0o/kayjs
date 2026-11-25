// JSON-RPC 2.0 & MCP Streamable HTTP (2025-03-26) dispatcher with bounded batch execution.

import type { ActionContext, RequestContext, ServerAction, ServerPluginAPI, StandardSchemaV1 } from '@kayjs/kay/server'
import type { McpPruneMode, McpToolResult } from './format'
import type { JsonSchemaObject } from './schema'
import { formatSchemaIssues, validateSchema } from '@kayjs/kay/server'
import { applyOutputBudget, finalizeToolValue, formatFieldErrors, formatResponseResult } from './format'

export const MCP_PROTOCOL_VERSION = '2025-03-26'
export const MAX_BATCH_SIZE = 50

export interface McpToolAnnotations {
  title?: string | undefined
  readOnlyHint?: boolean | undefined
  destructiveHint?: boolean | undefined
  idempotentHint?: boolean | undefined
  openWorldHint?: boolean | undefined
}

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null | undefined
  method: string
  params?: Record<string, unknown> | undefined
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number, message: string, data?: unknown }
}

export interface ListedTool {
  name: string
  description: string
  inputSchema: JsonSchemaObject
  annotations?: McpToolAnnotations
}

export interface ResolvedResource {
  uri: string
  name: string
  description?: string
  mimeType: string
  read: (ctx: RequestContext) => string | Promise<string>
}

export interface ResolvedToolEntry {
  name: string
  action?: ServerAction<unknown, unknown> | undefined
  schema: StandardSchemaV1 | undefined
  handler: (input: unknown, ctx: ActionContext) => unknown | Promise<unknown>
  format: ((output: unknown, input: unknown) => unknown) | undefined
  maxOutputChars: number | undefined
  pruneEmpty: McpPruneMode
}

export interface RpcDispatcherConfig {
  serverName: string
  serverVersion: string
  instructions?: string | undefined
  listedTools: readonly ListedTool[]
  toolMap: ReadonlyMap<string, ResolvedToolEntry>
  resourceMap: ReadonlyMap<string, ResolvedResource>
  listedResources: readonly { uri: string, name: string, description?: string, mimeType: string }[]
  formatResult?: ((output: unknown, toolName: string, input: unknown) => unknown) | undefined
  mapError?: ((error: unknown) => string | { message: string } | undefined) | undefined
  getServerApi: () => ServerPluginAPI | undefined
}

export function createRpcDispatcher(cfg: RpcDispatcherConfig) {
  const hasResources = cfg.resourceMap.size > 0
  const availableNamesHint = cfg.toolMap.size > 0 && cfg.toolMap.size <= 12
    ? ` (available: ${[...cfg.toolMap.keys()].join(', ')})`
    : ''

  async function callTool(name: string, args: unknown, ctx: RequestContext): Promise<McpToolResult> {
    const tool = cfg.toolMap.get(name)
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
      const serverApi = cfg.getServerApi()
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
          : (cfg.formatResult !== undefined ? cfg.formatResult(rawResult, name, input) : rawResult)
        mcpResult = await finalizeToolValue(formatted, tool.pruneEmpty)
      }
      return applyOutputBudget(mcpResult, tool.maxOutputChars)
    }
    catch (err) {
      const mapped = cfg.mapError?.(err)
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

  async function handleMessage(msg: unknown, ctx: RequestContext): Promise<JsonRpcResponse | null> {
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
            serverInfo: { name: cfg.serverName, version: cfg.serverVersion },
            ...(cfg.instructions !== undefined ? { instructions: cfg.instructions } : {}),
          },
        }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: cfg.listedTools,
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
          result: { resources: cfg.listedResources },
        }
      }

      case 'resources/read': {
        if (!hasResources)
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } }
        const uri = typeof req.params?.uri === 'string' ? req.params.uri : undefined
        if (uri === undefined)
          return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing resource uri' } }
        const resource = cfg.resourceMap.get(uri)
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

  async function handlePost(ctx: RequestContext): Promise<Response> {
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
          {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32600,
              message: payload.length === 0 ? 'Invalid Request' : `Batch size exceeds limit (${MAX_BATCH_SIZE})`,
            },
          },
          { status: 400 },
        )
      }
      const responses: JsonRpcResponse[] = []
      for (const item of payload) {
        const res = await handleMessage(item, ctx)
        if (res !== null)
          responses.push(res)
      }
      if (responses.length === 0)
        return new Response(null, { status: 202 })
      return Response.json(responses, { status: 200 })
    }

    const single = await handleMessage(payload, ctx)
    if (single === null)
      return new Response(null, { status: 202 })
    const status = single.error?.code === -32600 ? 400 : 200
    return Response.json(single, { status })
  }

  return { handleMessage, handlePost }
}
