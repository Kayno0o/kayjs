import { version } from '../../package.json'

type Id = number | string

interface Request {
  jsonrpc: '2.0'
  id?: Id | null
  method?: string
  params?: Record<string, unknown>
}

export interface Tool {
  name: string
  title: string
  description: string
  inputSchema: object
  annotations: { readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean }
  run: (args: Record<string, unknown>) => Promise<ToolResult>
}

export interface ToolResult {
  content: { type: 'text', text: string }[]
  structuredContent?: object
  isError?: boolean
}

export interface Resource {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
  read: () => Promise<string>
}

// A request the server answers with a JSON-RPC error rather than a result.
export class RpcError extends Error {
  override name = 'RpcError'

  constructor(readonly code: number, message: string, readonly data?: object) {
    super(message)
  }
}

export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603
const PARSE_ERROR = -32700
const UNSUPPORTED_PROTOCOL_VERSION = -32022

// The revision without a handshake, which a request names in its `_meta`, and the ones that open with `initialize`, newest first; the few messages used are the same in all.
const MODERN_VERSION = '2026-07-28'
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const VERSION_META = 'io.modelcontextprotocol/protocolVersion'
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo'
const SERVER_INFO = { name: 'kay', title: 'kay', version }

const INSTRUCTIONS = 'kay is a Bun web framework whose components are `.kay` files. Run `check` after editing a `.kay` file, `routes` to see what the app serves, `render` to see what a URL answers, `dev_errors` for what `kay dev` met, and `explain` for a lint or error code a report names. Read the `kay://llms.txt` resource first, it links the guide to each part of the framework.'

// Speaks MCP over newline-delimited JSON-RPC: both the revision that opens with `initialize` and the one carrying its version in every request's `_meta`, serving `tools` and `resources`.
export class McpServer {
  // `closing` runs when the client closes its input, before the calls still running are waited for.
  constructor(private readonly tools: Tool[], private readonly resources: Resource[], private readonly closing?: () => void) {}

  // Reads `input` line by line until it closes, answering each message through `write`.
  async serve(input: ReadableStream<Uint8Array>, write: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder()
    const pending = new Set<Promise<void>>()
    let buffer = ''

    const take = (line: string) => {
      if (line.trim() === '')
        return

      const answering = this.receive(line, write).finally(() => pending.delete(answering))

      pending.add(answering)
    }

    for await (const chunk of input) {
      buffer += decoder.decode(chunk, { stream: true })

      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        take(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
      }
    }

    take(buffer + decoder.decode())
    this.closing?.()
    await Promise.all(pending)
  }

  private async receive(line: string, output: (line: string) => void): Promise<void> {
    // A client that has gone leaves no one to answer.
    const write = (reply: string) => {
      try {
        output(reply)
      }
      catch {}
    }
    let message: Request

    try {
      message = JSON.parse(line) as Request
    }
    catch {
      write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } }))

      return
    }

    if (typeof message !== 'object' || message === null || Array.isArray(message) || typeof message.method !== 'string') {
      // A response or a batch: this server sends no requests, and the revisions it speaks have no batches.
      if (typeof message !== 'object' || message === null || !('result' in message || 'error' in message))
        write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid request' } }))

      return
    }

    // A notification, `notifications/initialized` and `notifications/cancelled` among them, takes no answer.
    if (message.id === undefined || message.id === null)
      return

    const { id } = message

    try {
      const result = await this.handle(message.method, message.params ?? {})

      write(JSON.stringify({ jsonrpc: '2.0', id, result }))
    }
    catch (error) {
      const rpc = error instanceof RpcError ? error : new RpcError(INTERNAL_ERROR, error instanceof Error ? error.message : String(error))

      write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: rpc.code, message: rpc.message, ...rpc.data && { data: rpc.data } } }))
    }
  }

  private async handle(method: string, params: Record<string, unknown>): Promise<object> {
    if (method === 'initialize') {
      const requested = params.protocolVersion

      return {
        protocolVersion: typeof requested === 'string' && LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0],
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      }
    }

    const meta = params._meta as Record<string, unknown> | undefined
    const requested = meta?.[VERSION_META]

    // A request naming a revision this server does not speak is told which it does.
    if (requested !== undefined && requested !== MODERN_VERSION && !(typeof requested === 'string' && LEGACY_VERSIONS.includes(requested)))
      throw new RpcError(UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: [MODERN_VERSION, ...LEGACY_VERSIONS], requested })

    const result = await this.dispatch(method, params)

    // Only the revision without a handshake asks for the result's kind and the server's identity.
    return requested === MODERN_VERSION ? { resultType: 'complete', ...result, _meta: { [SERVER_INFO_META]: SERVER_INFO } } : result
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<object> {
    switch (method) {
      case 'ping':
        return {}
      case 'server/discover':
        return { supportedVersions: [MODERN_VERSION], capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS }
      case 'tools/list':
        return { tools: this.tools.map(({ run: _run, ...tool }) => tool) }
      case 'tools/call':
        return this.call(params)
      case 'resources/list':
        return { resources: this.resources.map(({ read: _read, ...resource }) => resource) }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      case 'resources/read':
        return this.read(params)
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
  }

  private async call({ name, arguments: args = {} }: Record<string, unknown>): Promise<ToolResult> {
    const tool = typeof name === 'string' ? this.tools.find(tool => tool.name === name) : undefined

    if (!tool)
      throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(name)}`)

    if (typeof args !== 'object' || args === null || Array.isArray(args))
      throw new RpcError(INVALID_PARAMS, 'A tool takes its arguments as an object')

    try {
      return await tool.run(args as Record<string, unknown>)
    }
    catch (error) {
      if (error instanceof RpcError)
        throw error

      // A tool that could not do its work says why to the model, which may call it again differently.
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  }

  private async read({ uri }: Record<string, unknown>): Promise<object> {
    const resource = this.resources.find(resource => resource.uri === uri)

    if (!resource)
      throw new RpcError(INVALID_PARAMS, 'Resource not found', { uri })

    return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: await resource.read() }] }
  }
}
