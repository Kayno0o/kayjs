import type { Elysia } from 'elysia'
import type { ActionOptions } from './actions'
import type { LoadedGuard } from './guards'
import { dirname, relative } from 'node:path'
import { escape } from '../runtime/escape'
import { inLocale, passGuards } from './actions'
import { API_PREFIX } from './api'

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
  guards: string[]
}

type Schema = Record<string, unknown>

interface Operation {
  'tags': string[]
  'summary'?: string
  'description'?: string
  'deprecated'?: boolean
  'parameters'?: Schema[]
  'requestBody'?: Schema
  'responses': Record<string, Schema>
  'x-kay-guards'?: string[]
}

export const OPENAPI_PATH = `${API_PREFIX}/openapi.json`
export const REFERENCE_PATH = `${API_PREFIX}/reference`

const METHODS = new Set(['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE'])
const STATUS = /^\d{3}$/
const PATH_PARAM = /:(\w+)\??/g
const TRAILING_SLASH = /(?<=.)\/$/
// What TypeBox and Elysia add to a schema for themselves, or JSON Schema has no type for.
const NOT_JSON_TYPES = new Set(['Date', 'Uint8Array'])
const MODULE_FILE = /(?:\/index)?\.ts$/

// An OpenAPI 3.1 document of every route the modules serve, read from the schemas their routes declare; a route behind a guard names it, as `x-kay-guards`.
export function openApiDocument(modules: MountedApi[], options: { title: string, version: string, base: string }): Schema {
  const paths: Record<string, Record<string, Operation>> = {}

  for (const module of modules) {
    for (const route of module.instance.routes) {
      const method = route.method.toUpperCase()
      const hooks = route.hooks as Record<string, unknown> & { detail?: { summary?: string, description?: string, tags?: string[], deprecated?: boolean, hide?: boolean } }

      if (!METHODS.has(method) && method !== 'ALL')
        continue

      if (hooks.detail?.hide === true)
        continue

      const path = `${module.mount}${route.path === '/' ? '' : route.path}`.replace(TRAILING_SLASH, '')
      const operation: Operation = {
        tags: hooks.detail?.tags ?? [module.mount.slice(API_PREFIX.length + 1) || 'api'],
        ...hooks.detail?.summary !== undefined && { summary: hooks.detail.summary },
        ...hooks.detail?.description !== undefined && { description: hooks.detail.description },
        ...hooks.detail?.deprecated === true && { deprecated: true },
        ...parameters(path, hooks),
        ...hooks.body !== undefined && { requestBody: { required: true, content: { [holdsFile(hooks.body) ? 'multipart/form-data' : 'application/json']: { schema: jsonSchema(hooks.body) } } } },
        responses: responses(hooks.response),
        ...module.guards.length > 0 && { 'x-kay-guards': module.guards.map(file => relative(apiDir(module), file)) },
      }
      const methods = paths[path.replace(PATH_PARAM, '{$1}')] ??= {}

      for (const each of method === 'ALL' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : [method])
        methods[each.toLowerCase()] = operation
    }
  }

  return { openapi: '3.1.0', info: { title: options.title, version: options.version }, servers: [{ url: options.base || '/' }], paths }
}

// The API directory a module sits in, read back from its file and the path it is mounted at, so the document names guards by where they sit there, whatever machine built the server.
function apiDir(module: MountedApi): string {
  const path = module.file.replace(MODULE_FILE, '')

  return path.slice(0, path.length - (module.mount.length - API_PREFIX.length)) || dirname(module.file)
}

function parameters(path: string, hooks: Record<string, unknown>): { parameters?: Schema[] } {
  const found: Schema[] = []
  const declared = (hooks.params as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}

  for (const [, name] of path.matchAll(PATH_PARAM))
    found.push({ name, in: 'path', required: true, schema: jsonSchema(declared[name!] ?? { type: 'string' }) })

  for (const [where, schema] of [['query', hooks.query], ['header', hooks.headers]] as const) {
    const object = schema as { properties?: Record<string, unknown>, required?: string[] } | undefined

    for (const [name, property] of Object.entries(object?.properties ?? {}))
      found.push({ name, in: where, required: object?.required?.includes(name) === true, schema: jsonSchema(property) })
  }

  return found.length > 0 ? { parameters: found } : {}
}

// One schema for every answer, or one per status.
function responses(response: unknown): Record<string, Schema> {
  if (response === undefined || response === null)
    return { 200: { description: 'OK' } }

  const byStatus = Object.keys(response).length > 0 && Object.keys(response).every(key => STATUS.test(key)) ? response as Record<string, unknown> : { 200: response }

  return Object.fromEntries(Object.entries(byStatus).map(([status, schema]) => [status, { description: status.startsWith('2') ? 'OK' : 'Error', content: { 'application/json': { schema: jsonSchema(schema) } } }]))
}

function holdsFile(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null)
    return false

  return (schema as Schema).format === 'binary' || Object.values(schema).some(holdsFile)
}

// A plain JSON Schema: TypeBox's symbols and Elysia's own marks left out, and of a union the members JSON cannot carry, such as a Date object beside its text.
function jsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema))
    return schema.map(jsonSchema)

  if (typeof schema !== 'object' || schema === null)
    return schema

  const plain: Schema = {}

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'elysiaMeta' || (key === 'default' && (schema as Schema).format === 'binary'))
      continue

    if (key === 'anyOf' && Array.isArray(value)) {
      const kept = value.filter(member => !NOT_JSON_TYPES.has((member as Schema).type as string) && Object.keys(member as Schema).some(name => name !== 'default'))

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

// The document at `/api/openapi.json`, and the reference page when asked for, behind the guard of the API directory itself when it has one.
export function serveOpenApi(app: Elysia, document: Schema, config: OpenApiConfig, guards: LoadedGuard[], options: ActionOptions): void {
  const json = JSON.stringify(document)
  const admitted = async (request: Request, answer: () => Response) => {
    const passed = guards.length > 0 ? await inLocale(request, options, async () => passGuards(guards, { request }, {}, options)) : undefined

    return passed instanceof Response ? passed : answer()
  }

  app.get(OPENAPI_PATH, async ({ request }) => admitted(request, () => new Response(json, { headers: { 'content-type': 'application/json; charset=utf-8' } })))

  if (config.reference === true) {
    const html = referencePage(document)

    app.get(REFERENCE_PATH, async ({ request }) => admitted(request, () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })))
  }
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
      operation.requestBody ? `<h3>Body</h3><pre>${escape(JSON.stringify(Object.values((operation.requestBody as { content: Record<string, { schema: unknown }> }).content)[0]!.schema, null, 2))}</pre>` : '',
      `<h3>Responses</h3><dl>${Object.entries(operation.responses).map(([status, response]) => `<dt>${status}</dt><dd>${response.content !== undefined ? `<pre>${escape(JSON.stringify((response.content as Record<string, { schema: unknown }>)['application/json']!.schema, null, 2))}</pre>` : escape(String(response.description))}</dd>`).join('')}</dl>`,
    ]

    return `<section>${parts.join('')}</section>`
  }))

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(info.title)} API</title></head><body><h1>${escape(info.title)} <small>${escape(info.version)}</small></h1><p><a href="openapi.json">OpenAPI document</a></p>${sections.join('')}</body></html>`
}
