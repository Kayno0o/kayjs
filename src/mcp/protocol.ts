import { version } from '../../package.json'

interface Request {
  jsonrpc: '2.0'
  id?: unknown
  method?: string
  params?: unknown
}

export interface Tool {
  name: string
  title: string
  description: string
  inputSchema: object
  annotations: { readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean }
  run: (args: Record<string, unknown>) => Promise<ToolResult>
}

export type Content = { type: 'text', text: string } | { type: 'image', data: string, mimeType: string } | { type: 'resource', resource: { uri: string, mimeType: string, blob: string } }

export interface ToolResult {
  content: Content[]
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

// What one message is answered with, as JSON-RPC writes it.
export interface Reply {
  jsonrpc: '2.0'
  id: string | number | null
  result?: object
  error?: { code: number, message: string, data?: object }
}

// What names the server to its client, and what it tells a model about it.
export interface ServerOptions {
  serverInfo?: { name: string, title: string, version: string }
  // None for a server with nothing to say beyond its tools.
  instructions?: string | undefined
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
export const PARSE_ERROR = -32700
const UNSUPPORTED_PROTOCOL_VERSION = -32022

// The revision without a handshake, which a request names in its `_meta`, and the ones that open with `initialize`, newest first; the few messages used are the same in all.
const MODERN_VERSION = '2026-07-28'
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const VERSION_META = 'io.modelcontextprotocol/protocolVersion'
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo'
const SERVER_INFO = { name: 'kay', title: 'kay', version }
// The results the revision without a handshake lets a client keep, which must then say for how long and for whom.
const CACHEABLE = new Set(['server/discover', 'tools/list', 'resources/list', 'resources/templates/list', 'resources/read'])
// An app's tools change with a deploy and can hang on who calls, through its guards: a client fetches them again each time and shares them with no other credentials.
const NO_CACHE = { ttlMs: 0, cacheScope: 'private' }

// The longest line read, a request being far shorter; a longer one is refused instead of growing the buffer.
const MAX_LINE = 4 * 1024 * 1024

const INSTRUCTIONS = 'kay is a Bun web framework whose components are `.kay` files. Run `check` after editing a `.kay` file, `routes` to see what the app serves, `render` to see what a URL answers, `dev_errors` for what `kay dev` met, and `explain` for a lint or error code a report names. Read the `kay://llms.txt` resource first, it links the guide to each part of the framework.'

// The id of a message that is no valid request, when it is one a reply can carry.
function readableId(message: unknown): string | number | null {
  const id = typeof message === 'object' && message !== null && !Array.isArray(message) ? (message as Request).id : undefined

  return typeof id === 'string' || typeof id === 'number' ? id : null
}

// Speaks MCP over newline-delimited JSON-RPC: both the revision that opens with `initialize` and the one carrying its version in every request's `_meta`, serving `tools` and `resources`.
export class McpServer {
  // `closing` runs when the client closes its input, as the calls still running are waited for.
  constructor(private readonly tools: Tool[], private readonly resources: Resource[], private readonly closing?: () => void, private readonly options: ServerOptions = { instructions: INSTRUCTIONS }) {}

  // Reads `input` line by line until it closes, answering each message through `write`.
  async serve(input: ReadableStream<Uint8Array>, write: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder()
    const pending = new Set<Promise<void>>()
    let buffer = ''
    // Set once a line went over the cap, until its newline ends it.
    let skipping = false

    const tooLong = () => write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: `Request over ${MAX_LINE} bytes` } }))

    const take = (line: string) => {
      if (line.trim() === '')
        return

      if (line.length > MAX_LINE) {
        tooLong()

        return
      }

      const answering = this.receive(line, write).finally(() => pending.delete(answering))

      pending.add(answering)
    }

    for await (const chunk of input) {
      buffer += decoder.decode(chunk, { stream: true })

      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        if (skipping)
          skipping = false
        else
          take(buffer.slice(0, end))

        buffer = buffer.slice(end + 1)
      }

      if (buffer.length > MAX_LINE) {
        if (!skipping)
          tooLong()

        skipping = true
        buffer = ''
      }
    }

    if (!skipping)
      take(buffer + decoder.decode())

    this.closing?.()
    await Promise.all(pending)
  }

  private async receive(line: string, output: (line: string) => void): Promise<void> {
    const reply = await this.answer(line)

    // A client that has gone leaves no one to answer.
    try {
      if (reply)
        output(JSON.stringify(reply))
    }
    catch {}
  }

  // Answers one message, undefined for a notification or a response, which take none.
  async answer(line: string): Promise<Reply | undefined> {
    let message: unknown

    try {
      message = JSON.parse(line)
    }
    catch {
      return { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } }
    }

    return this.answerMessage(message)
  }

  // Answers a message already parsed from JSON, for a caller that read it first.
  async answerMessage(parsed: unknown): Promise<Reply | undefined> {
    const message = parsed as Request

    if (typeof message !== 'object' || message === null || Array.isArray(message) || typeof message.method !== 'string') {
      // A response or a batch: this server sends no requests, and the revisions it speaks have no batches.
      if (typeof message !== 'object' || message === null || !('result' in message || 'error' in message))
        return { jsonrpc: '2.0', id: readableId(message), error: { code: INVALID_REQUEST, message: 'Invalid request' } }

      return undefined
    }

    // A notification, `notifications/initialized` and `notifications/cancelled` among them, takes no answer.
    if (message.id === undefined || message.id === null)
      return undefined

    const { id } = message

    if (typeof id !== 'string' && typeof id !== 'number')
      return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'A request id is a string or a number' } }

    try {
      const params = message.params === undefined ? {} : message.params

      if (typeof params !== 'object' || params === null || Array.isArray(params))
        throw new RpcError(INVALID_PARAMS, 'Params are an object')

      return { jsonrpc: '2.0', id, result: await this.handle(message.method, params as Record<string, unknown>) }
    }
    catch (error) {
      const rpc = error instanceof RpcError ? error : new RpcError(INTERNAL_ERROR, error instanceof Error ? error.message : String(error))

      return { jsonrpc: '2.0', id, error: { code: rpc.code, message: rpc.message, ...rpc.data && { data: rpc.data } } }
    }
  }

  private capabilities(): object {
    return this.resources.length > 0 ? { tools: {}, resources: {} } : { tools: {} }
  }

  private async handle(method: string, params: Record<string, unknown>): Promise<object> {
    if (method === 'initialize') {
      const requested = params.protocolVersion

      return {
        protocolVersion: typeof requested === 'string' && LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0],
        capabilities: this.capabilities(),
        serverInfo: this.options.serverInfo ?? SERVER_INFO,
        ...this.options.instructions !== undefined && { instructions: this.options.instructions },
      }
    }

    const meta = params._meta as Record<string, unknown> | undefined
    const requested = meta?.[VERSION_META]

    // A request naming a revision this server does not speak is told which it does.
    if (requested !== undefined && requested !== MODERN_VERSION && !(typeof requested === 'string' && LEGACY_VERSIONS.includes(requested)))
      throw new RpcError(UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: [MODERN_VERSION, ...LEGACY_VERSIONS], requested })

    const result = await this.dispatch(method, params)

    // Only the revision without a handshake asks for the result's kind and the server's identity.
    return requested === MODERN_VERSION ? { resultType: 'complete', ...result, ...CACHEABLE.has(method) && NO_CACHE, _meta: { [SERVER_INFO_META]: this.options.serverInfo ?? SERVER_INFO } } : result
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<object> {
    switch (method) {
      case 'ping':
        return {}
      case 'server/discover':
        return { supportedVersions: [MODERN_VERSION], capabilities: this.capabilities(), ...this.options.instructions !== undefined && { instructions: this.options.instructions } }
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
