import type { TSchema } from 'elysia'
import type { TypeCheck } from 'elysia/type-system'
import type { RawEntry } from './load'
import type { ComponentSegment, Segment } from './markdown'
import { mapValueError } from 'elysia'
import { TypeCompiler } from 'elysia/type-system'

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

const FIELD = /^\/([^/]*)/
const checks = new WeakMap<TSchema, TypeCheck<TSchema>>()

// Each entry's data read against the schema, defaults filled in and values decoded, such as a date from its text; the components each uses must be ones the collection names.
export function decodeEntries(entries: RawEntry[], schema: TSchema, components: Record<string, unknown>, localized = false): { entry: RawEntry, data: unknown }[] {
  const check = checkOf(schema)

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

    const seen = new Set<string>()

    for (const issue of check.Errors(data)) {
      const field = FIELD.exec(issue.path)?.[1] ?? ''

      if (seen.has(field))
        continue

      seen.add(field)
      problems.push({ file: entry.file, line: entry.lines[field] ?? 1, message: `${field === '' ? 'the data' : field}: ${mapValueError(issue)?.summary ?? issue.message}` })
    }
  }

  if (problems.length > 0)
    throw new ContentError(problems)

  return decoded
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
  const check = checkOf(schema)
  const filled = withDefaults(data, schema)
  const issues = new Map<string, string>()

  if (check.Check(filled))
    return []

  for (const issue of check.Errors(filled)) {
    const path = issue.path.split('/').slice(1).map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~')).join('.')

    if (!issues.has(path))
      issues.set(path, mapValueError(issue)?.summary ?? issue.message)
  }

  return [...issues].map(([path, message]) => ({ path, message }))
}

function checkOf(schema: TSchema): TypeCheck<TSchema> {
  let check = checks.get(schema)

  if (!check)
    checks.set(schema, check = TypeCompiler.Compile(schema))

  return check
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
