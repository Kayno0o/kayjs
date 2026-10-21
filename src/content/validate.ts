import type { TSchema } from 'elysia'
import type { RawEntry } from './load'
import type { ComponentSegment, Segment } from './markdown'
import { compiledCheck, dottedPath, refusals } from '../server/schema-check'
import { entryRefusal, kayWord } from '../server/words'

export interface ContentProblem {
  // Relative to the project root.
  file: string
  line: number
  message: string
  // The lint it is, for one `lints` sets the level of.
  code?: string | undefined
}

// Every entry of a collection that does not compile or match its schema, reported together.
export class ContentError extends Error {
  override name = 'ContentError'
  readonly code = 'content-invalid'

  constructor(readonly problems: ContentProblem[]) {
    super(`kay: ${problems.length === 1 ? 'an entry does' : `${problems.length} entries do`} not match the collection\n${problems.map(problem => `  ${problem.file}:${problem.line} ${problem.message}`).join('\n')}`)
  }
}

interface ObjectSchema {
  properties?: Record<string, { default?: unknown }>
}

// Each entry's data read against the schema, defaults filled in and values decoded, such as a date from its text; the components each uses must be ones the collection names.
export function decodeEntries(entries: RawEntry[], schema: TSchema, components: Record<string, unknown>, localized = false): { entry: RawEntry, data: unknown }[] {
  const check = compiledCheck(schema)

  const problems: ContentProblem[] = []
  const decoded: { entry: RawEntry, data: unknown }[] = []
  const paired = new Map<string, RawEntry>()

  for (const entry of entries) {
    const data = withDefaults(entry.data, schema)

    if (localized)
      pairingProblem(entry, paired, problems)

    if (localized && !entry.slug.includes('/'))
      problems.push({ file: entry.file, line: 1, message: 'sits outside a locale folder, where a localized collection keeps each entry: fr/hello.md' })

    for (const { component, line } of unknownComponents(entry.segments ?? [], components))
      problems.push({ file: entry.file, line, message: `uses <${component}>, which the collection's components do not name` })

    if (check.Check(data)) {
      decoded.push({ entry, data: check.Decode(data) })

      continue
    }

    // Each refused field by its own dotted path, on the line its top-level field starts at.
    for (const [path, message] of refusals(check, data, dottedPath, issue => refusalSentence(schema, issue)))
      problems.push({ file: entry.file, line: entry.lines[topField(path)] ?? 1, message: path === '' ? message : `${path}: ${message}` })
  }

  if (problems.length > 0)
    throw new ContentError(problems)

  return decoded
}

function topField(path: string): string {
  const dot = path.indexOf('.')

  return dot === -1 ? path : path.slice(0, dot)
}

// A localized collection pairs the entries of a locale with their translations by key, so two of one locale cannot share one: a `translationKey` field, else the slug after its locale's folder.
function pairingProblem(entry: RawEntry, paired: Map<string, RawEntry>, problems: ContentProblem[]): void {
  const given = typeof entry.data === 'object' && entry.data !== null ? (entry.data as { translationKey?: unknown }).translationKey : undefined

  if (given !== undefined && typeof given !== 'string') {
    problems.push({ file: entry.file, line: entry.lines.translationKey ?? 1, message: 'translationKey is not a string' })

    return
  }

  const [locale = '', ...rest] = entry.slug.split('/')
  const key = given === undefined || given === '' ? rest.join('/') : given
  const id = `${locale}\0${key}`
  const taken = paired.get(id)

  if (taken)
    problems.push({ file: entry.file, line: entry.lines.translationKey ?? 1, message: `translationKey ${key} pairs the entry as ${taken.file} does; rename one` })
  else
    paired.set(id, entry)
}

// Where a draft's data fails the schema, each field by its dotted path, `tags.0`, at most once.
export function dataIssues(schema: TSchema, data: unknown): { path: string, message: string }[] {
  const check = compiledCheck(schema)
  const filled = withDefaults(data, schema)

  if (check.Check(filled))
    return []

  return [...refusals(check, filled, dottedPath, issue => refusalSentence(schema, issue))].map(([path, message]) => ({ path, message }))
}

const INDEX = /^\d+$/

interface Node {
  title?: unknown
  properties?: Record<string, Node>
  items?: Node
  anyOf?: Node[]
}

// The node of a field one step down: a property by its name, an array's item by its index, looking through the branches of a union such as a nullable field.
function stepInto(node: Node | undefined, segment: string): Node | undefined {
  for (const candidate of [node, ...node?.anyOf ?? []]) {
    const found = candidate?.properties?.[segment] ?? (INDEX.test(segment) ? candidate?.items : undefined)

    if (found)
      return found
  }

  return undefined
}

// A field's `title`, else a branch's of its union, such as the inner type of a nullable one.
function titleOf(node: Node | undefined): string | undefined {
  return [node, ...node?.anyOf ?? []].map(candidate => candidate?.title).find((title): title is string => typeof title === 'string')
}

// How an entry names a field: its schema `title`, else its key worded (`publishedAt` gives `Published at`), an item of a list as `Tags, item 2`.
export function labelOf(schema: TSchema, pointer: string): string {
  const segments = pointer.split('/').slice(1).map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
  let node: Node | undefined = schema
  let label = ''

  for (const segment of segments) {
    node = stepInto(node, segment)

    label = INDEX.test(segment) ? kayWord('kay.entry.item', { field: label, n: Number(segment) + 1 }) : titleOf(node) ?? humanize(segment)
  }

  return label === '' ? kayWord('kay.entry.data') : label
}

// The words of a key: `publishedAt` gives `Published at`, `seoURL` gives `Seo URL`, an acronym keeping its capitals; `_` and `-` only separate.
const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z\d]+/g

// The same words the CMS labels a field with, `packages/cms/src/fields.ts`, which runs in the browser and cannot import this.
function humanize(key: string): string {
  const words = (key.match(WORD) ?? [key]).map(word => word === word.toUpperCase() && word.length > 1 ? word : word.toLowerCase()).join(' ')

  return words.charAt(0).toUpperCase() + words.slice(1)
}

// The sentence for a refused field: its label, then the keyword it fails, in the request's locale.
function refusalSentence(schema: TSchema, issue: { path: string, schema?: unknown, value?: unknown }): string {
  return entryRefusal(labelOf(schema, issue.path), issue)
}

function withDefaults(data: unknown, schema: TSchema): unknown {
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return data

  const filled = { ...data as Record<string, unknown> }

  for (const [name, field] of Object.entries((schema as ObjectSchema).properties ?? {})) {
    if (filled[name] === undefined && field.default !== undefined)
      filled[name] = structuredClone(field.default)
  }

  return filled
}

export function unknownComponents(segments: Segment[], components: Record<string, unknown>, found: ComponentSegment[] = []): ComponentSegment[] {
  for (const segment of segments) {
    if (typeof segment === 'string')
      continue

    if (!(segment.component in components))
      found.push(segment)

    unknownComponents(segment.children, components, found)
  }

  return found
}
