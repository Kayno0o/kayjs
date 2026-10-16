import type { Elysia } from 'elysia'
import type { Server } from 'elysia/universal'
import type { Tool, ToolResult } from '../mcp/protocol'
import type { BodyLimit } from './body'
import { AsyncLocalStorage } from 'node:async_hooks'
import { INVALID_REQUEST, McpServer, PARSE_ERROR } from '../mcp/protocol'
import { joinBase } from '../runtime/base'
import { configuredSite } from '../runtime/site'
import { FAILURE_HEADER, REDIRECT_HEADER } from '../runtime/swap'
import { decodeServerValue, encodeValue } from '../runtime/wire'
import { isCrossSite } from './actions'
import { MCP_PATH } from './api-modules'
import { clientAddress, keepRequestId, markAgentCall, requestId } from './protection'
import { requestUrl } from './request-url'
import { sendFrom } from './rewrite'
import { visitAs } from './visit'

type Schema = Record<string, unknown>
type Handle = (request: Request) => Promise<Response>

interface Operation {
  'operationId': string
  'summary'?: string
  'description'?: string
  'parameters'?: { name: string, in: string, required?: boolean, schema: Schema }[]
  'requestBody'?: { required?: boolean, content: Record<string, { schema: Schema }> }
  'x-kay-action'?: true
}

// What a call to a tool needs of the request that made it.
interface CallContext {
  request: Request
  server: Server | null
  // Set when a guard refused the call for want of a sign-in, which the endpoint answers 401.
  challenged: boolean
}

interface AppTool extends Omit<Tool, 'run'> {
  call: (args: Record<string, unknown>, context: CallContext) => Promise<ToolResult>
}

// Marks a request the endpoint dispatched, so only it skips what a form needs; one value per process, so no client can send it.
const AGENT = 'x-kay-agent'
const CLIENT = 'x-kay-agent-client'
const TOKEN = crypto.randomUUID()
// What the caller's request carries on to the action or route it calls: who it is, how it is worded and which scheme it came by.
const FORWARDED = ['authorization', 'cookie', 'accept-language', 'user-agent', 'x-forwarded-proto', 'x-forwarded-host']
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
const PATH_PARAM = /\{(\w+)\}/g
const JSON_TYPE = /\bjson\b/
const TEXT_TYPE = /^text\/|\bjson\b|\bxml\b/
const DOT_SEGMENT = /^\.{1,2}$/
const RESOURCE_METADATA = '/.well-known/oauth-protected-resource'
const NO_BODY = new Set(['get', 'delete'])

// The headers every answer of the endpoint carries.
const ANSWER = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

// A tool per operation of the document that a JSON call can make: an action that opted in, or an API route whose body, if any, is a JSON object.
export function documentedTools(document: Schema, fallback: Handle): AppTool[] {
  const tools: AppTool[] = []

  for (const [path, methods] of Object.entries(document.paths as Record<string, Record<string, Operation>>)) {
    for (const [method, operation] of Object.entries(methods)) {
      const tool = HTTP_METHODS.has(method) ? toolOf(path, method, operation, fallback) : undefined

      if (tool)
        tools.push(tool)
    }
  }

  return tools
}

function toolOf(path: string, method: string, operation: Operation, fallback: Handle): AppTool | undefined {
  const description = [operation.summary, operation.description].filter(text => text !== undefined).join('\n\n') || `${method.toUpperCase()} ${path}`
  const body = operation.requestBody?.content['application/json']?.schema
  const action = operation['x-kay-action'] === true

  // A body of files, text or bytes cannot go as arguments.
  if (operation.requestBody && (body === undefined || body.type !== 'object'))
    return undefined

  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  const places = new Map<string, Set<'path' | 'query' | 'body'>>()
  const place = (name: string, where: 'path' | 'query' | 'body', schema: unknown, needed: boolean) => {
    properties[name] ??= schema

    if (needed)
      required.add(name)

    places.set(name, (places.get(name) ?? new Set()).add(where))
  }

  for (const parameter of operation.parameters ?? []) {
    if (parameter.in === 'path' || parameter.in === 'query')
      place(parameter.name, parameter.in, parameter.schema, parameter.required === true)
  }

  for (const [name, schema] of Object.entries((body?.properties ?? {}) as Record<string, unknown>))
    place(name, 'body', schema, ((body?.required ?? []) as string[]).includes(name))

  const get = method === 'get'
  const inputSchema = { type: 'object', properties, ...required.size > 0 && { required: [...required] } }

  return {
    name: operation.operationId,
    title: operation.operationId,
    description,
    inputSchema,
    annotations: { readOnlyHint: get, destructiveHint: method === 'delete', idempotentHint: get || method === 'put' || method === 'delete', openWorldHint: false },
    call: async (args, context) => {
      const url = urlFor(path, operation.parameters ?? [], args, places)

      if (typeof url !== 'string')
        return url

      const init: RequestInit = { method: method.toUpperCase(), headers: { accept: 'application/json' } }

      if (action) {
        init.headers = { 'accept': 'application/json', 'content-type': 'application/json', 'x-kay-action': '1' }
        init.body = encodeValue(args)
      }
      else if (!NO_BODY.has(method) && operation.requestBody) {
        init.headers = { 'accept': 'application/json', 'content-type': 'application/json' }
        init.body = JSON.stringify(Object.fromEntries(Object.entries(args).filter(([name]) => places.get(name)?.has('body'))))
      }

      return dispatch(context, url, init, action, fallback)
    },
  }
}

// The path and query a call asks for, or the result that tells the agent what it left out; a value cannot reach another route, whatever it holds.
function urlFor(path: string, parameters: NonNullable<Operation['parameters']>, args: Record<string, unknown>, places: Map<string, Set<string>>): string | ToolResult {
  let missing: string | undefined
  const filled = path.replace(PATH_PARAM, (_, name: string) => {
    const value = args[name]
    const text = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''

    // An empty or dot segment names another route once the URL is resolved.
    if (text === '' || DOT_SEGMENT.test(text))
      missing ??= name

    return encodeURIComponent(text)
  })

  if (missing !== undefined)
    return refusal(`The argument ${missing} is a single path segment, neither empty nor . or ..`)

  const query = new URLSearchParams()

  for (const { name, in: where } of parameters) {
    const value = args[name]

    if (where !== 'query' || value === undefined || !places.get(name)?.has('query'))
      continue

    for (const each of Array.isArray(value) ? value : [value])
      query.append(name, typeof each === 'object' ? JSON.stringify(each) : String(each))
  }

  return query.size > 0 ? `${filled}?${query}` : filled
}

function refusal(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

// Sends the call through the whole app as a fetch would, so its guards, rate limits and `ctx.locals` are the web path's, and words what came back for the agent.
async function dispatch(context: CallContext, url: string, init: RequestInit, action: boolean, fallback: Handle): Promise<ToolResult> {
  const { request, server } = context
  const headers = new Headers(init.headers)

  for (const name of FORWARDED) {
    const value = request.headers.get(name)

    if (value !== null)
      headers.set(name, value)
  }

  headers.set(AGENT, TOKEN)
  headers.set(CLIENT, clientAddress(request, server))
  headers.set('x-request-id', requestId(request))

  const visit = new Request(new URL(url, request.url), { ...init, headers, redirect: 'manual' })
  const response = await visitAs(request, visit, server, fallback)

  return result(context, response, action)
}

// Words what the app answered for the agent: the result, or why there is none, which it may correct and call again.
async function result(context: CallContext, response: Response, action: boolean): Promise<ToolResult> {
  const type = response.headers.get('content-type') ?? ''
  const location = response.headers.get(REDIRECT_HEADER) ?? response.headers.get('location')

  if (location !== null)
    return refusal(`The call ended in a redirect to ${location}, where a page would carry on`)

  if (!action && response.ok && response.body && type !== '' && !TEXT_TYPE.test(type))
    return { content: [{ type: 'text', text: `${type || 'Binary data'}, ${(await response.arrayBuffer()).byteLength} bytes` }] }

  const text = await response.text()

  if (response.status === 401) {
    context.challenged = true

    return refusal(text || 'Sign in to continue')
  }

  if (response.headers.has(FAILURE_HEADER)) {
    const { errors, data } = decodeServerValue(text) as { errors: Record<string, string>, data: unknown }

    return refusal(json({ status: response.status, errors, ...data !== undefined && { data } }))
  }

  if (!response.ok)
    return refusal(text || `Answered ${response.status}`)

  if (action) {
    const value = text === '' ? undefined : decodeServerValue(text)

    return value === undefined ? { content: [{ type: 'text', text: 'Done' }] } : sent(value)
  }

  if (!JSON_TYPE.test(type))
    return { content: [{ type: 'text', text }] }

  try {
    return { content: [{ type: 'text', text }], ...isRecord(JSON.parse(text)) && { structuredContent: JSON.parse(text) as object } }
  }
  catch {
    return { content: [{ type: 'text', text }] }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

// What an action returned, as the text a model reads and as structured data when it is an object.
function sent(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : json(value)

  return { content: [{ type: 'text', text }], ...isRecord(value) && { structuredContent: JSON.parse(text) as object } }
}

// JSON for what devalue carried, whose Dates are their text, bigints digits, Maps objects and Sets arrays.
function json(value: unknown): string {
  return JSON.stringify(value, (_, each: unknown) => {
    if (typeof each === 'bigint')
      return each.toString()

    if (each instanceof Map)
      return Object.fromEntries(each) as unknown

    return each instanceof Set ? [...each] : each
  })
}

export interface McpOptions {
  title: string
  version: string
  // Where the app is mounted, which the pointer to its sign-in metadata is served under.
  base: string
}

// Counts a request the endpoint dispatched as the client it came from and drops the marker, so the app never reads it.
function receiveDispatched(app: Elysia): void {
  app.onRequest(({ request }) => {
    const marked = request.headers.get(AGENT)
    const address = request.headers.get(CLIENT)
    const id = request.headers.get('x-request-id')

    if (marked === null)
      return

    request.headers.delete(AGENT)
    request.headers.delete(CLIENT)

    // A header an outside client sent is dropped with the rest, and counts for nothing.
    if (marked !== TOKEN)
      return

    markAgentCall(request)

    if (address !== null)
      sendFrom(request, address)

    if (id !== null)
      keepRequestId(request, id)
  })
}

// Where a client that was refused for want of a sign-in finds how to get one.
function resourceMetadata(request: Request, base: string): string {
  return new URL(joinBase(base, RESOURCE_METADATA), configuredSite()?.origin ?? requestUrl(request).origin).href
}

export const mcpBodyLimit: BodyLimit = {
  bytes: undefined,
  refuse: () => new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Request too large' } }), { status: 413, headers: ANSWER }),
}

// Serves the tools of `document` at `/mcp` over Streamable HTTP: one JSON-RPC message per POST, answered with JSON.
export function serveMcp(app: Elysia, document: Schema, options: McpOptions): void {
  const calls = new AsyncLocalStorage<CallContext>()
  const tools = documentedTools(document, async request => app.handle(request)).map(({ call, ...tool }): Tool => ({ ...tool, run: async args => call(args, calls.getStore()!) }))
  const mcp = new McpServer(tools, [], undefined, { serverInfo: { name: options.title, title: options.title, version: options.version } })
  const notAllowed = () => new Response(null, { status: 405, headers: { allow: 'POST' } })

  receiveDispatched(app)

  app.post(MCP_PATH, async ({ request, server }) => {
    // A browser page of another site posting here would act with the visitor's cookies.
    if (isCrossSite(request))
      return new Response('Cross-site request refused', { status: 403 })

    const context: CallContext = { request, server, challenged: false }
    const reply = await calls.run(context, async () => mcp.answer(await request.text()))

    if (!reply)
      return new Response(null, { status: 202 })

    const headers = new Headers(ANSWER)

    if (context.challenged)
      headers.set('www-authenticate', `Bearer resource_metadata="${resourceMetadata(request, options.base)}"`)

    // A message that is no request at all is the client's mistake, answered as such.
    const unreadable = reply.error?.code === PARSE_ERROR || reply.error?.code === INVALID_REQUEST

    let status = unreadable ? 400 : 200

    if (context.challenged)
      status = 401

    return new Response(JSON.stringify(reply), { status, headers })
  })
  app.get(MCP_PATH, notAllowed)
  app.delete(MCP_PATH, notAllowed)
}
