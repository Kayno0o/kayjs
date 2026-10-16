import type { Elysia } from 'elysia'
import type { Server } from 'elysia/universal'
import type { Tool, ToolResult } from '../mcp/protocol'
import type { ActionOptions } from './actions'
import type { BodyLimit } from './body'
import type { LoadedGuard } from './guards'
import type { Operation } from './openapi'
import { AsyncLocalStorage } from 'node:async_hooks'
import { INVALID_REQUEST, McpServer, PARSE_ERROR } from '../mcp/protocol'
import { joinBase } from '../runtime/base'
import { configuredSite } from '../runtime/site'
import { FAILURE_HEADER, REDIRECT_HEADER } from '../runtime/swap'
import { decodeServerValue, encodeValue } from '../runtime/wire'
import { isCrossSite } from './actions'
import { MCP_PATH, RESOURCE_METADATA } from './api-modules'
import { guardRefusal, toolName } from './openapi'
import { clientAddress, keepRequestId, markAgentCall, requestId, wasChallenged } from './protection'
import { requestUrl } from './request-url'
import { sendFrom } from './rewrite'
import { visitAs } from './visit'

type Schema = Record<string, unknown>
type Handle = (request: Request) => Promise<Response>

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
const TOOL = 'x-kay-agent-tool'
const TOKEN = crypto.randomUUID()
// What the caller's request carries on to the action or route it calls: who it is, how it is worded and which scheme it came by.
const FORWARDED = ['authorization', 'cookie', 'accept-language', 'user-agent', 'x-forwarded-proto', 'x-forwarded-host']
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
const PATH_PARAM = /\{(\w+)\}/g
const JSON_TYPE = /\bjson\b/
const TEXT_TYPE = /^text\/|\bjson\b|\bxml\b/
const DOT_SEGMENT = /^\.{1,2}$/
// The JSON-RPC code of a request a guard refused, in the range the spec leaves to servers.
const REFUSED = -32001
const NO_BODY = new Set(['get', 'delete'])

// The headers every answer of the endpoint carries.
const ANSWER = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

// A tool per operation of the document that opted in and that a JSON call can make: an action that set `tool`, or an API route that did and whose body, if any, is a JSON object.
export function documentedTools(document: Schema, fallback: Handle): AppTool[] {
  const tools: AppTool[] = []

  // Made safe as names and told apart here, as a route's own `operationId` is kept as written in the document.
  const taken = new Set<string>()

  for (const [path, methods] of Object.entries(document.paths as Record<string, Record<string, Operation>>)) {
    for (const [method, operation] of Object.entries(methods)) {
      const tool = HTTP_METHODS.has(method) && operation.operationId !== undefined && isTool(operation) ? toolOf(path, method, operation, operation.operationId, fallback, taken) : undefined

      if (tool)
        tools.push(tool)
    }
  }

  return tools
}

// An action that opted in, or an API route that set `tool`: the others are in the document and never offered.
function isTool(operation: Operation): boolean {
  return operation['x-kay-action'] === true || operation['x-kay-tool'] !== undefined
}

function toolOf(path: string, method: string, operation: Operation, id: string, fallback: Handle, taken: Set<string>): AppTool | undefined {
  const tool = operation['x-kay-tool']
  const description = tool?.description ?? ([operation.summary, operation.description].filter(text => text !== undefined).join('\n\n') || `${method.toUpperCase()} ${path}`)
  const body = operation.requestBody?.content['application/json']?.schema as Schema | undefined
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

  const name = toolName(tool?.name ?? id, taken)

  return {
    name,
    title: name,
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

      return dispatch(context, url, init, action, fallback, name)
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
async function dispatch(context: CallContext, url: string, init: RequestInit, action: boolean, fallback: Handle, tool: string): Promise<ToolResult> {
  const { request, server } = context
  const headers = new Headers(init.headers)

  for (const name of FORWARDED) {
    const value = request.headers.get(name)

    if (value !== null)
      headers.set(name, value)
  }

  headers.set(AGENT, TOKEN)
  headers.set(CLIENT, clientAddress(request, server))
  headers.set(TOOL, tool)
  headers.set('x-request-id', requestId(request))

  const visit = new Request(new URL(url, request.url), { ...init, headers, redirect: 'manual' })
  const response = await visitAs(request, visit, server, fallback)

  return result(context, visit, response, action)
}

// Words what the app answered for the agent: the result, or why there is none, which it may correct and call again.
async function result(context: CallContext, visit: Request, response: Response, action: boolean): Promise<ToolResult> {
  const type = response.headers.get('content-type') ?? ''
  const location = response.headers.get(REDIRECT_HEADER) ?? response.headers.get('location')

  if (location !== null)
    return refusal(`The call ended in a redirect to ${location}, where a page would carry on`)

  if (!action && response.ok && response.body && type !== '' && !TEXT_TYPE.test(type))
    return { content: [{ type: 'text', text: `${type}, ${(await response.arrayBuffer()).byteLength} bytes` }] }

  const text = await response.text()

  // Only a guard's 401 asks for a sign-in, as a route answering 401 on its own account says something else.
  if (response.status === 401 && wasChallenged(visit)) {
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

  const parsed = parseJson(text)

  return { content: [{ type: 'text', text }], ...isRecord(parsed) && { structuredContent: parsed } }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
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
  // The guards of the API directory, which `tools/list` runs as the OpenAPI document does.
  guards: LoadedGuard[]
  actions: ActionOptions
  // The sign-in metadata paths kay serves: one the app serves itself is left out.
  metadataPaths: string[]
}

// A tool call the endpoint dispatched: which tool it calls, and the address of the client that asked for it.
export interface ToolCall {
  tool: string
  client: string
}

const toolCalls = new WeakMap<Request, ToolCall>()

// Whether `request` is a tool call the MCP endpoint dispatched, and which: from a hook registered before `pages()` and from a guard alike.
// Only the endpoint holds the per-process marker, so a header a client sends makes no call a tool call.
export function toolCall(request: Request): ToolCall | undefined {
  const read = toolCalls.get(request)

  if (read !== undefined)
    return read

  const tool = request.headers.get(TOOL)

  return request.headers.get(AGENT) === TOKEN && tool !== null ? { tool, client: request.headers.get(CLIENT) ?? '' } : undefined
}

// Counts a request the endpoint dispatched as the client it came from and drops the marker, so the app never reads it.
function receiveDispatched(app: Elysia): void {
  app.onRequest(({ request }) => {
    const marked = toolCall(request)
    const address = request.headers.get(CLIENT)
    const id = request.headers.get('x-request-id')

    request.headers.delete(AGENT)
    request.headers.delete(CLIENT)
    request.headers.delete(TOOL)

    // A header an outside client sent is dropped with the rest, and counts for nothing.
    if (marked === undefined)
      return

    toolCalls.set(request, marked)
    markAgentCall(request)

    if (address !== null)
      sendFrom(request, address)

    if (id !== null)
      keepRequestId(request, id)
  })
}

// The request id of the message when it asks what only the directory's guard may show: `tools/list`, or a call to a name no tool has, which would tell a name that is a tool from one that is not.
function guardedMessage(message: unknown, known: Set<string>): { id: string | number | null, call: boolean } | undefined {
  if (!isRecord(message))
    return undefined

  const name = isRecord(message.params) ? message.params.name : undefined

  if (message.method !== 'tools/list' && !(message.method === 'tools/call' && !(typeof name === 'string' && known.has(name))))
    return undefined

  return { id: typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null, call: message.method === 'tools/call' }
}

// Headers of a refusal that describe its own body or redirect, which the JSON-RPC answer replaces.
const OWN_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'transfer-encoding', 'location', 'cache-control'])

// What a guard's refusal is as a JSON-RPC error: a sign-in request with the pointer when it is a 401 or a redirect, else the refusal's own status; the guard's headers go with it, `Retry-After` of a 429 among them.
// A sign-in request to a call is worded as a guarded tool's is, a result that is an error, so the answer does not tell which names are tools.
async function declined(denied: Response, id: string | number | null, request: Request, base: string, call: boolean, owner: string | undefined): Promise<Response> {
  const challenge = denied.status === 401 || (denied.status >= 300 && denied.status < 400)
  const headers = new Headers(ANSWER)

  for (const [name, value] of denied.headers) {
    if (!OWN_HEADERS.has(name))
      headers.append(name, value)
  }

  if (challenge)
    headers.set('www-authenticate', `Bearer resource_metadata="${resourceMetadata(request, base, owner)}"`)

  const message = challenge && denied.status !== 401 ? '' : await denied.text()

  const text = message || 'Sign in to continue'
  const body = challenge && call ? { jsonrpc: '2.0', id, result: refusal(text) } : { jsonrpc: '2.0', id, error: { code: REFUSED, message: text } }

  return new Response(JSON.stringify(body), { status: challenge ? 401 : denied.status, headers })
}

// Where a client that was refused for want of a sign-in finds how to get one.
function resourceMetadata(request: Request, base: string, origin: string | undefined): string {
  return new URL(joinBase(base, RESOURCE_METADATA), configuredSite()?.origin ?? origin ?? requestUrl(request).origin).href
}

// The origin the auth library serves its documents at, which the pointer to them must agree with.
function originOf(served: unknown): string | undefined {
  return (served as { auth?: ResourceOwner }).auth?.oauthOrigin?.()
}

export const mcpBodyLimit: BodyLimit = {
  bytes: undefined,
  refuse: () => new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Request too large' } }), { status: 413, headers: ANSWER }),
}

// What an auth library with an OAuth server of its own, kayjs-auth, tells of it through the `auth` of the context.
interface ResourceOwner {
  oauthResource?: (path: string, name: string) => Record<string, unknown> | null
  oauthOrigin?: () => string | undefined
  oauthFixed?: () => boolean
}

// The OAuth 2.0 protected resource metadata (RFC 9728) a client finds from the 401's pointer, or at the well-known path of the endpoint: the auth library's answer, which names its authorization server, else a 404 for an app that signs no one in by OAuth.
function serveResourceMetadata(app: Elysia, name: string, paths: string[]): void {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }

  for (const route of paths) {
    app.get(route, (served) => {
      const owner = (served as unknown as { auth?: ResourceOwner }).auth
      const document = owner?.oauthResource?.(MCP_PATH, name)
      // An origin taken from the request is whatever its Host header said, so no shared cache keeps the document.
      const cache = configuredSite() !== undefined || owner?.oauthFixed?.() === true ? 'public, max-age=300' : 'private, max-age=300'

      return document ? new Response(JSON.stringify(document), { headers: { ...headers, 'cache-control': cache } }) : new Response(null, { status: 404 })
    })
    app.options(route, () => new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type, mcp-protocol-version', 'access-control-max-age': '86400' } }))
  }
}

// Serves the tools of `document` at `/mcp` over Streamable HTTP: one JSON-RPC message per POST, answered with JSON.
export function serveMcp(app: Elysia, document: Schema, options: McpOptions): void {
  const calls = new AsyncLocalStorage<CallContext>()
  const tools = documentedTools(document, async request => app.handle(request)).map(({ call, ...tool }): Tool => ({ ...tool, run: async args => call(args, calls.getStore()!) }))
  const known = new Set(tools.map(tool => tool.name))
  const mcp = new McpServer(tools, [], undefined, { serverInfo: { name: options.title, title: options.title, version: options.version } })
  const notAllowed = () => new Response(null, { status: 405, headers: { allow: 'POST' } })

  receiveDispatched(app)

  app.post(MCP_PATH, async (served) => {
    const { request, server } = served

    // A browser page of another site posting here would act with the visitor's cookies.
    if (isCrossSite(request))
      return new Response('Cross-site request refused', { status: 403 })

    const text = await request.text()
    const message = parseJson(text)
    const guarded = guardedMessage(message, known)

    // The list names every tool and the guarded routes behind them, so it is as private as the document is.
    if (guarded !== undefined) {
      const refusal = await guardRefusal(options.guards, served, options.actions)

      if (refusal)
        return declined(refusal, guarded.id, request, options.base, guarded.call, originOf(served))
    }

    const context: CallContext = { request, server, challenged: false }
    // A text that is no JSON goes to the server as it is, which words the parse error.
    const reply = await calls.run(context, async () => message === undefined ? mcp.answer(text) : mcp.answerMessage(message))

    if (!reply)
      return new Response(null, { status: 202 })

    const headers = new Headers(ANSWER)

    if (context.challenged)
      headers.set('www-authenticate', `Bearer resource_metadata="${resourceMetadata(request, options.base, originOf(served))}"`)

    // A message that is no request at all is the client's mistake, answered as such.
    const unreadable = reply.error?.code === PARSE_ERROR || reply.error?.code === INVALID_REQUEST

    let status = unreadable ? 400 : 200

    if (context.challenged)
      status = 401

    return new Response(JSON.stringify(reply), { status, headers })
  }, { parse: 'none' })
  app.get(MCP_PATH, notAllowed)
  app.delete(MCP_PATH, notAllowed)
  serveResourceMetadata(app, options.title, options.metadataPaths)
}
