import type { TSchema } from 'elysia'
import type { EntryOf } from './index'

// A value the data holds in a `reference()` field: where it sits, as the dotted path of `dataIssues`, the top-level field it sits under, the collection it names and the slug.
export interface ReferenceUse {
  path: string
  field: string
  collection: string
  slug: string
}

interface ReferenceNode {
  'properties'?: Record<string, ReferenceNode>
  'items'?: ReferenceNode
  'anyOf'?: ReferenceNode[]
  'allOf'?: ReferenceNode[]
  'x-kay'?: { kind?: unknown, collection?: unknown }
}

// Every slug an entry's data gives a `reference()` field, however deep in objects, lists, unions and the items of `blocks()`; a null, an empty string or a value of another type names nothing.
export function referencesIn(schema: TSchema, data: unknown): ReferenceUse[] {
  const found = new Map<string, ReferenceUse>()

  collect(schema as ReferenceNode, data, [], found)

  return [...found.values()]
}

function collect(node: ReferenceNode, value: unknown, path: string[], found: Map<string, ReferenceUse>): void {
  const hint = node['x-kay']

  if (hint?.kind === 'reference' && typeof hint.collection === 'string' && typeof value === 'string' && value !== '')
    found.set(path.join('.'), { path: path.join('.'), field: path[0] ?? '', collection: hint.collection, slug: value })

  if (Array.isArray(value)) {
    if (node.items !== undefined) {
      for (const [index, item] of value.entries()) {
        collect(node.items, item, [...path, String(index)], found)
      }
    }
  }
  else if (typeof value === 'object' && value !== null) {
    for (const [key, property] of Object.entries(node.properties ?? {}))
      collect(property, (value as Record<string, unknown>)[key], [...path, key], found)
  }

  const type = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as { type?: unknown }).type : undefined

  for (const variant of [...node.anyOf ?? [], ...node.allOf ?? []]) {
    const block = (variant as { properties?: { type?: { const?: unknown } } }).properties?.type?.const

    // A block's item is read against the block its `type` names alone.
    if (type === undefined || block === undefined || block === type)
      collect(variant, value, path, found)
  }
}

// What `resolve` reads: any collection.
interface Target<Data, Routed extends boolean> {
  get: (slug: string) => Promise<EntryOf<Data, Routed> | undefined>
}

// A collection's entry for a slug a `reference()` field holds, or undefined when the collection has none or holds it back: a draft in production, an entry not yet published. A list of slugs gives the entries found, in order; a null or undefined gives undefined (or none). In a localized collection the request's locale's entry, else the default locale's, as `get` reads it.
export function resolve<Data, Routed extends boolean>(slugs: readonly string[] | null | undefined, target: Target<Data, Routed>): Promise<EntryOf<Data, Routed>[]>
export function resolve<Data, Routed extends boolean>(slug: string | null | undefined, target: Target<Data, Routed>): Promise<EntryOf<Data, Routed> | undefined>
export async function resolve<Data, Routed extends boolean>(slug: string | readonly string[] | null | undefined, target: Target<Data, Routed>): Promise<EntryOf<Data, Routed> | EntryOf<Data, Routed>[] | undefined> {
  if (typeof slug !== 'string')
    return slug === null || slug === undefined ? undefined : (await Promise.all(slug.map(async each => target.get(each)))).filter(entry => entry !== undefined)

  return target.get(slug)
}
