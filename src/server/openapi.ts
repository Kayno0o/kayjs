import type { Elysia } from 'elysia'
import type { ActionTool } from '../runtime/action'
import type { ActionOptions } from './actions'
import type { ApiGuard } from './api-modules'
import type { LoadedGuard } from './guards'
import type { ServedPaths } from './served-paths'
import { basename, relative } from 'node:path'
import { NON_ROOT_TRAILING_SLASH } from '../runtime/base'
import { escape } from '../runtime/escape'
import { inLocale, passGuards } from './actions'
import { API_PREFIX, OPENAPI_PATH, REFERENCE_PATH } from './api-modules'
import { sharedContext } from './render'
import { apiRoutePath } from './routes'
import { toolSettings } from './tool-settings'

export interface OpenApiConfig {
  // The document's `info`, the site's `seo.name` and `1.0.0` by default.
  title?: string | undefined
  version?: string | undefined
  // Also serves a page listing the routes, at `/api/reference`.
  reference?: boolean | undefined
  // Served by `kay dev` alone.
  dev?: boolean | undefined
}

// A module as `serveApi` mounted it, its routes read off the instance.
export interface MountedApi {
  file: string
  mount: string
  instance: Elysia
  guards: ApiGuard[]
}

type Schema = Record<string, unknown>

// A tool action as the document lists it.
export interface DocumentedAction {
  // The name it is exported under, `addNote`.
  name: string
  url: string
  schema: unknown
  // What `tool` on the action sets, by itself or beside its description.
  tool: { name?: string | undefined, description?: string | undefined }
  // The files of the guards covering it, shown relative to `root`.
  guards: string[]
}

interface Parameter {
  name: string
  in: string
  required?: boolean
  schema: unknown
}

interface RequestBody {
  required?: boolean
  content: Record<string, { schema: unknown }>
}

export interface Operation {
  'operationId'?: string
  'tags': string[]
  'summary'?: string
  'description'?: string
  'deprecated'?: boolean
  'parameters'?: Parameter[]
  'requestBody'?: RequestBody
  'responses': Record<string, Schema>
  'x-kay-guards'?: string[]
  // Set on a route that opted in to being an MCP tool, with what its `detail.tool` sets: the name and description the tool takes in place of the operation's.
  'x-kay-tool'?: { name?: string | undefined, description?: string | undefined }
  // Called as kay's `action()` calls are, which an MCP tool does, rather than as a plain JSON `POST`.
  'x-kay-action'?: true
}

export function openApiSettings(value: boolean | OpenApiConfig | undefined): OpenApiConfig | undefined {
  if (value === true)
    return {}

  return value === false ? undefined : value
}

const METHODS = new Set(['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE'])
// What a route answering every method, `.all()`, is listed under.
const ANY_METHOD = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const STATUS = /^\d{3}$/
const PATH_PARAM = /:(\w+)\??/g
const OPTIONAL_SEGMENT = /\/:\w+\?/g
const WILDCARD = /\*$/
const BRACED_PARAM = /\{(\w+)\}/g
// What JSON Schema has no type for: a Date object beside its text is left out of a union, raw bytes are binary text.
const DATE = 'Date'
const BYTES = 'Uint8Array'
const BINARY = { type: 'string', format: 'binary' }

type Route = MountedApi['instance']['routes'][number]

// The paths a route answers, as the router reads them: one without each optional param and one with it.
function routerPaths(module: MountedApi, route: Route): string[] {
  const path = apiRoutePath(module.mount, route.path).replace(NON_ROOT_TRAILING_SLASH, '')
  const bare = path.replace(OPTIONAL_SEGMENT, '')

  return bare === path ? [path] : [bare || API_PREFIX, path.replaceAll('?', '')]
}

// The paths a route answers, as the document writes them, a wildcard named `wildcard`.
function routePaths(module: MountedApi, route: Route): string[] {
  return routerPaths(module, route).map(variant => variant.replace(PATH_PARAM, '{$1}').replace(WILDCARD, '{wildcard}'))
}

// Each module's routes claim their paths, after the document and the reference page when `config` serves them, which a module would hide without a word.
export function claimApi(served: ServedPaths, modules: MountedApi[], config: OpenApiConfig | undefined): void {
  const own = new Map<string, string>(config ? [[OPENAPI_PATH, 'its document'], ...config.reference === true ? [[REFERENCE_PATH, 'its reference page'] as const] : []] : [])

  for (const path of own.keys())
    served.claim({ path, owner: '`openapi`', kind: 'kay' })

  for (const module of modules) {
    for (const route of module.instance.routes) {
      for (const path of routerPaths(module, route)) {
        served.claim({ path, owner: module.file, kind: 'api', method: route.method.toUpperCase() }, (taken) => {
          const what = taken.kind === 'kay' ? own.get(taken.path) : undefined

          return what === undefined ? `kay: ${taken.owner} and ${module.file} both serve ${path}` : `kay: ${module.file} serves ${path}, where \`openapi\` serves ${what}; move the route, or turn ${path === OPENAPI_PATH ? '`openapi` off' : 'the reference page off'}`
        })
      }
    }
  }
}

const TOOL_NAME = /\W+/g
const EDGE_UNDERSCORES = /^_+|_+$/g
const WORD_BREAK = /([a-z\d])([A-Z])/g
const API_ROOT = new RegExp(`^${API_PREFIX}`)
// The most characters an MCP client takes in a tool's name.
const MAX_NAME = 64

// `base` made safe as a tool's name, and `taken` kept free of it: a second one gets `_2`, a third `_3`.
export function toolName(base: string, taken: Set<string>): string {
  const name = safeName(base)
  let candidate = name.slice(0, MAX_NAME)

  for (let count = 2; taken.has(candidate); count++)
    candidate = `${name.slice(0, MAX_NAME - String(count).length - 1)}_${count}`

  taken.add(candidate)

  return candidate
}

function safeName(base: string): string {
  return base.replace(TOOL_NAME, '_').replace(EDGE_UNDERSCORES, '') || 'tool'
}

// A route's own `operationId` as it was written, only kept free of `taken` the way a tool's name is.
function operationName(id: string, taken: Set<string>): string {
  let candidate = id

  for (let count = 2; taken.has(candidate); count++)
    candidate = `${id}_${count}`

  taken.add(candidate)

  return candidate
}

// An export's name as a tool is named: `addNote` is `add_note`.
function snakeCase(name: string): string {
  return name.replace(WORD_BREAK, '$1_$2').toLowerCase()
}

// An OpenAPI 3.1 document of every route the modules serve, read from the schemas their routes declare, and of the actions that opted in to being tools; a route behind a guard names it, as `x-kay-guards`.
// Each operation has an `operationId`, the route's own `detail.operationId` as written or its method and path: `get_items_id` for `GET /api/items/{id}`. The MCP tools are named after them, made safe as names.
export function openApiDocument(modules: MountedApi[], options: { title: string, version: string, base: string, root?: string }, actions: DocumentedAction[] = []): Schema {
  const paths: Record<string, Record<string, Operation>> = {}
  // Routes for every method, which give way to a route for one method wherever it was declared.
  const anyMethod: { path: string, operation: Operation }[] = []
  const wanted = new Map<Operation, string>()

  for (const module of modules) {
    for (const route of module.instance.routes) {
      const method = route.method.toUpperCase()
      const hooks = route.hooks as Record<string, unknown> & { detail?: { summary?: string, description?: string, tags?: string[], deprecated?: boolean, hide?: boolean, operationId?: string, tool?: boolean | string | ActionTool } }

      if ((!METHODS.has(method) && method !== 'ALL') || hooks.detail?.hide === true)
        continue

      for (const path of routePaths(module, route)) {
        const tool = toolSettings(hooks.detail?.tool)
        const operation: Operation = {
          tags: hooks.detail?.tags ?? [module.mount.slice(API_PREFIX.length + 1) || 'api'],
          ...hooks.detail?.summary !== undefined && { summary: hooks.detail.summary },
          ...hooks.detail?.description !== undefined && { description: hooks.detail.description },
          ...hooks.detail?.deprecated === true && { deprecated: true },
          ...parameters(path, hooks),
          ...hooks.body !== undefined && { requestBody: { required: true, content: content(hooks.body, holdsFile(hooks.body) ? 'multipart/form-data' : 'application/json') } },
          responses: responses(hooks.response),
          ...module.guards.length > 0 && { 'x-kay-guards': module.guards.map(guard => guard.path) },
          ...tool && { 'x-kay-tool': tool },
        }

        // A route that sets no id takes its tool's name, as an action's id is.
        const chosen = hooks.detail?.operationId !== undefined && hooks.detail.operationId !== '' ? hooks.detail.operationId : tool?.name

        if (chosen !== undefined && chosen !== '')
          wanted.set(operation, chosen)

        if (method === 'ALL')
          anyMethod.push({ path, operation })
        else
          (paths[path] ??= {})[method.toLowerCase()] = operation
      }
    }
  }

  for (const { path, operation } of anyMethod) {
    const methods = paths[path] ??= {}

    const id = wanted.get(operation)

    // One operation per method cannot share an id, so each takes the method as a suffix.
    wanted.delete(operation)

    for (const each of ANY_METHOD) {
      const method = each.toLowerCase()

      if (methods[method] !== undefined)
        continue

      const tool = operation['x-kay-tool']

      // Each method is a tool of its own, so a chosen name takes the method too.
      methods[method] = { ...operation, ...tool?.name !== undefined && { 'x-kay-tool': { ...tool, name: `${tool.name}_${method}` } } }

      if (id !== undefined)
        wanted.set(methods[method], `${id}_${method}`)
    }
  }

  const named = new Set<string>()
  // The tool names the ids come to, so a generated id never takes the name a chosen one is given as a tool.
  const tools = new Set<string>()

  for (const [operation, name] of wanted) {
    operation.operationId = operationName(name, named)
    tools.add(safeName(operation.operationId).slice(0, MAX_NAME))
  }

  // A name a route chose for its tool is taken too, whatever its id is.
  for (const methods of Object.values(paths)) {
    for (const operation of Object.values(methods)) {
      const chosen = operation['x-kay-tool']?.name

      if (chosen !== undefined)
        tools.add(safeName(chosen).slice(0, MAX_NAME))
    }
  }

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods))
      operation.operationId ??= toolName(`${method}/${path.replace(API_ROOT, '')}`, tools)
  }

  for (const action of actions) {
    // Files do not go as arguments.
    if (holdsFile(action.schema))
      continue

    const guards = action.guards.map(file => options.root === undefined ? basename(file) : relative(options.root, file))

    paths[action.url] = {
      post: {
        'operationId': toolName(action.tool.name ?? snakeCase(action.name), tools),
        'tags': ['actions'],
        ...action.tool.description !== undefined && { summary: action.tool.description },
        'requestBody': { required: true, content: content(action.schema, 'application/json') },
        'responses': { 200: { description: 'OK' } },
        ...guards.length > 0 && { 'x-kay-guards': guards },
        'x-kay-action': true,
      },
    }
  }

  return { openapi: '3.1.0', info: { title: options.title, version: options.version }, servers: [{ url: options.base || '/' }], paths }
}

function parameters(path: string, hooks: Record<string, unknown>): { parameters?: Parameter[] } {
  const found: Parameter[] = []
  const declared = (hooks.params as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}

  for (const [, name] of path.matchAll(BRACED_PARAM))
    found.push({ name: name!, in: 'path', required: true, schema: name === 'wildcard' ? schemaOf(declared['*'] ?? { type: 'string' }) : schemaOf(declared[name!] ?? { type: 'string' }) })

  for (const [where, schema] of [['query', hooks.query], ['header', hooks.headers]] as const) {
    const object = schema as { properties?: Record<string, unknown>, required?: string[] } | undefined

    for (const [name, property] of Object.entries(object?.properties ?? {}))
      found.push({ name, in: where, required: object?.required?.includes(name) === true, schema: schemaOf(property) })
  }

  return found.length > 0 ? { parameters: found } : {}
}

// One schema for every answer, or one per status.
function responses(response: unknown): Record<string, Schema> {
  if (response === undefined || response === null || typeof response !== 'object')
    return { 200: { description: 'OK' } }

  const byStatus = Object.keys(response).length > 0 && Object.keys(response).every(key => STATUS.test(key)) ? response as Record<string, unknown> : { 200: response }

  return Object.fromEntries(Object.entries(byStatus).map(([status, schema]) => [status, { description: status.startsWith('2') ? 'OK' : 'Error', content: content(schema, 'application/json') }]))
}

// A schema under the type it goes as: raw bytes as such, text as text, anything else as `fallback`.
function content(schema: unknown, fallback: string): Record<string, { schema: unknown }> {
  const plain = schemaOf(schema) as Schema
  let type = fallback

  if (plain.format === 'binary')
    type = 'application/octet-stream'
  else if (plain.type === 'string' && fallback === 'application/json')
    type = 'text/plain'

  return { [type]: { schema: plain } }
}

function holdsFile(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null)
    return false

  return Object.values(schema).some(value => typeof value === 'object' && value !== null && ((value as Schema).format === 'binary' || holdsFile(value)))
}

// A route's schema as JSON Schema; one kay cannot read, a model's name or another library's validator, says nothing.
function schemaOf(schema: unknown): unknown {
  return typeof schema !== 'object' || schema === null || '~standard' in schema ? {} : jsonSchema(schema)
}

// A plain JSON Schema: TypeBox's symbols and Elysia's own marks left out, a bigint as a number.
function jsonSchema(schema: unknown): unknown {
  if (typeof schema === 'bigint')
    return Number.isSafeInteger(Number(schema)) ? Number(schema) : schema.toString()

  if (Array.isArray(schema))
    return schema.map(jsonSchema)

  if (typeof schema !== 'object' || schema === null)
    return schema

  const source = schema as Schema

  if (source.type === BYTES)
    return BINARY

  const plain: Schema = {}

  for (const [key, value] of Object.entries(source)) {
    if (key === 'elysiaMeta' || (key === 'default' && (value === 'File' || value === 'Files')))
      continue

    if (key === 'type' && value === 'bigint') {
      plain.type = 'integer'

      continue
    }

    if (key === 'anyOf' && Array.isArray(value)) {
      // Elysia's `t.Uint8Array()` is a union of an example and the bytes.
      if (value.some(member => (member as Schema).type === BYTES))
        return BINARY

      const kept = value.filter(member => (member as Schema).type !== DATE)

      if (kept.length === 1)
        Object.assign(plain, jsonSchema(kept[0]))
      else
        plain.anyOf = kept.map(jsonSchema)

      continue
    }

    plain[key] = jsonSchema(value)
  }

  return plain
}

// The answer of the API directory's guards when one stops the request, else undefined. They get what an API route's does, the app's session and other plugins included.
export async function guardRefusal(guards: LoadedGuard[], context: { request: Request }, options: ActionOptions): Promise<Response | undefined> {
  const { request } = context
  const passed = guards.length > 0 ? await inLocale(request, options, async () => passGuards(guards, sharedContext(request, () => ({ ...context })), {}, options)) : undefined

  return passed instanceof Response ? passed : undefined
}

// The document at `/api/openapi.json`, and the reference page when asked for, behind the guard of the API directory itself when it has one.
export function serveOpenApi(app: Elysia, document: Schema, config: OpenApiConfig, guards: LoadedGuard[], options: ActionOptions): void {
  const json = JSON.stringify(document)
  const admitted = async (context: { request: Request }, answer: () => Response) => (await guardRefusal(guards, context, options)) ?? answer()

  app.get(OPENAPI_PATH, async context => admitted(context, () => new Response(json, { headers: { 'content-type': 'application/json; charset=utf-8' } })))

  if (config.reference === true) {
    const html = referencePage(document)

    app.get(REFERENCE_PATH, async context => admitted(context, () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })))
  }
}

// A body or an answer: its type and schema.
function schemaBlock(described: object): string {
  const [type, { schema }] = Object.entries((described as RequestBody).content)[0]!

  return `<p>${escape(type)}</p><pre>${escape(JSON.stringify(schema, null, 2))}</pre>`
}

// Every route with what it takes and answers, as plain HTML that needs no script or style the site's policy would have to allow.
function referencePage(document: Schema): string {
  const info = document.info as { title: string, version: string }
  const sections = Object.entries(document.paths as Record<string, Record<string, Operation>>).flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => {
    const parts = [
      `<h2><code>${method.toUpperCase()} ${escape(path)}</code></h2>`,
      operation.summary === undefined ? '' : `<p>${escape(operation.summary)}</p>`,
      operation.description === undefined ? '' : `<p>${escape(operation.description)}</p>`,
      operation['x-kay-guards'] ? `<p>Guarded by ${operation['x-kay-guards'].map(file => `<code>${escape(file)}</code>`).join(', ')}</p>` : '',
      operation.parameters ? `<h3>Parameters</h3><ul>${operation.parameters.map(parameter => `<li><code>${escape(String(parameter.name))}</code> in ${String(parameter.in)}${parameter.required === true ? ', required' : ''}: <code>${escape(JSON.stringify(parameter.schema))}</code></li>`).join('')}</ul>` : '',
      operation.requestBody ? `<h3>Body</h3>${schemaBlock(operation.requestBody)}` : '',
      `<h3>Responses</h3><dl>${Object.entries(operation.responses).map(([status, response]) => `<dt>${status}</dt><dd>${response.content !== undefined ? schemaBlock(response) : escape(String(response.description))}</dd>`).join('')}</dl>`,
    ]

    return `<section>${parts.join('')}</section>`
  }))

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(info.title)} API</title></head><body><h1>${escape(info.title)} <small>${escape(info.version)}</small></h1><p><a href="openapi.json">OpenAPI document</a></p>${sections.join('')}</body></html>`
}
