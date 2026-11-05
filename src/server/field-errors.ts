import type { TSchema, ValidationError } from 'elysia'
import { fieldOf } from './schema-check'
import { invalidWord, schemaRefusal } from './words'

const withoutFunctions = new WeakMap<object, unknown>()

// Where a stripped node keeps its `error` function, on the node itself: a schema Elysia merges or clones (a guard's with the route's) keeps own symbols, where a lookup by the identity of the whole schema would miss it.
const STRIPPED_ERROR = Symbol.for('kay.strippedError')

// The text an `error` option gives a field, a string or the string a function returns; a function that throws or returns anything else gives none, so the field keeps its default wording.
// A function is called where the caller runs, which is inside the request's locale.
export function errorText(error: unknown): string | undefined {
  if (typeof error === 'function') {
    try {
      const text = (error as () => unknown)()

      return typeof text === 'string' ? text : undefined
    }
    catch {
      return undefined
    }
  }

  return typeof error === 'string' ? error : undefined
}

function isNode(value: unknown): value is Record<string | symbol, unknown> {
  if (typeof value !== 'object' || value === null)
    return false

  const prototype = Object.getPrototypeOf(value) as unknown

  return prototype === Object.prototype || prototype === null
}

function hasErrorFunction(node: unknown): boolean {
  if (Array.isArray(node))
    return node.some(hasErrorFunction)

  return isNode(node) && Object.entries(node).some(([key, value]) => (key === 'error' && typeof value === 'function') || hasErrorFunction(value))
}

function stripped(node: unknown): unknown {
  if (Array.isArray(node))
    return node.map(stripped)

  if (!isNode(node))
    return node

  const copy = Object.create(Object.getPrototypeOf(node) as object | null) as Record<string | symbol, unknown>

  for (const key of Reflect.ownKeys(node)) {
    if (key === 'error' && typeof node[key] === 'function')
      copy[STRIPPED_ERROR] = node[key]
    else
      copy[key] = stripped(node[key])
  }

  return copy
}

// The schema Elysia validates with: the same, but for the `error` functions, which Elysia would call outside the request's locale and which kay reads itself with `fieldMessage`.
export function validated(schema: TSchema): TSchema {
  if (!hasErrorFunction(schema))
    return schema

  if (!withoutFunctions.has(schema)) {
    const copy = stripped(schema)

    withoutFunctions.set(schema, copy)
  }

  return withoutFunctions.get(schema) as TSchema
}

const segmentOf = (segment: string): string => segment.replaceAll('~1', '/').replaceAll('~0', '~')

// The first `error` found on the way down: a field's own, else a branch of its `anyOf`.
function find(node: unknown, segments: string[]): string | undefined {
  if (!isNode(node))
    return undefined

  const [head, ...rest] = segments
  const named = head !== undefined && isNode(node.properties) && Object.hasOwn(node.properties, head)
  const found = head === undefined ? errorText(node.error ?? node[STRIPPED_ERROR]) : find(named ? (node.properties as Record<string, unknown>)[head] : node.items, rest)

  if (found !== undefined || !Array.isArray(node.anyOf))
    return found

  for (const branch of node.anyOf) {
    const inBranch = find(branch, segments)

    if (inBranch !== undefined)
      return inBranch
  }

  return undefined
}

// The `error` option at a JSON pointer of the action's own schema, a field's, an item's or one of a union's branches, read in the current locale.
export function fieldMessage(schema: unknown, pointer: string): string | undefined {
  return find(schema, pointer.split('/').slice(1).map(segmentOf))
}

// The `kay.invalid.*` text for what an issue refused, Elysia's own summary when the site words none; the limit it names goes in as `{min}` or `{max}`, a format as `{format}`.
function refusalText(issue: { summary?: string | undefined, schema?: unknown, value?: unknown }): string {
  const { kind, params } = schemaRefusal(issue)

  return invalidWord(`kay.invalid.${kind}`, issue.summary, params)
}

// A message per field the schema refused: its own `error` when it has one, else the `kay.invalid.*` text, both in the current locale.
// An issue of a Standard Schema validator has no TypeBox schema: its dotted path names the field and its own message is the text.
export function refusedFields(schema: unknown, error: Readonly<ValidationError>): Record<string, string> {
  const errors: Record<string, string> = Object.create(null) as Record<string, string>

  for (const issue of error.all) {
    if (!('schema' in issue)) {
      const standard = issue as { path?: string, summary?: string, message?: string }
      const dot = standard.path?.indexOf('.') ?? -1
      const named = dot < 0 ? standard.path : standard.path?.slice(0, dot)

      errors[named === undefined || named === 'root' ? '' : named] ??= standard.summary ?? standard.message ?? 'Invalid value'

      continue
    }

    const field = 'path' in issue ? fieldOf(issue.path) : ''
    const own = 'schema' in issue ? (issue.schema as { error?: unknown }).error : undefined
    const custom = ('path' in issue ? fieldMessage(schema, issue.path) : undefined) ?? (typeof own === 'string' ? own : undefined)

    errors[field] ??= custom ?? refusalText(issue)
  }

  return errors
}
