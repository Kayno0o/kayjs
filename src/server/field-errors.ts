import type { TSchema } from 'elysia'

const withoutFunctions = new WeakMap<object, unknown>()

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
    if (!(key === 'error' && typeof node[key] === 'function'))
      copy[key] = stripped(node[key])
  }

  return copy
}

// The schema Elysia validates with: the same, but for the `error` functions, which Elysia would call outside the request's locale and which kay reads itself with `fieldMessage`.
export function validated(schema: TSchema): TSchema {
  if (!hasErrorFunction(schema))
    return schema

  if (!withoutFunctions.has(schema))
    withoutFunctions.set(schema, stripped(schema))

  return withoutFunctions.get(schema) as TSchema
}

const segmentOf = (segment: string): string => segment.replaceAll('~1', '/').replaceAll('~0', '~')

// The first `error` found on the way down: a field's own, else a branch of its `anyOf`.
function find(node: unknown, segments: string[]): string | undefined {
  if (!isNode(node))
    return undefined

  const [head, ...rest] = segments
  const named = head !== undefined && isNode(node.properties) && Object.hasOwn(node.properties, head)
  const found = head === undefined ? errorText(node.error) : find(named ? (node.properties as Record<string, unknown>)[head] : node.items, rest)

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
