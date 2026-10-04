import type { TSchema } from 'elysia'
import type { TypeCheck } from 'elysia/type-system'
import type { RawEntry } from './load'
import type { Segment } from './markdown'
import { mapValueError } from 'elysia'
import { TypeCompiler } from 'elysia/type-system'

export interface ContentProblem {
  // Relative to the project root.
  file: string
  line: number
  message: string
}

// Every entry of a collection that does not compile or match its schema, reported together.
export class ContentError extends Error {
  override name = 'ContentError'

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
export function decodeEntries(entries: RawEntry[], schema: TSchema, components: Record<string, unknown>): { entry: RawEntry, data: unknown }[] {
  let check = checks.get(schema)

  if (!check)
    checks.set(schema, check = TypeCompiler.Compile(schema))

  const problems: ContentProblem[] = []
  const decoded: { entry: RawEntry, data: unknown }[] = []

  for (const entry of entries) {
    const data = withDefaults(entry.data, schema)
    const unknown = unknownComponents(entry.segments ?? [], components)

    for (const name of unknown)
      problems.push({ file: entry.file, line: 1, message: `uses <${name}>, which the collection's components do not name` })

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

function unknownComponents(segments: Segment[], components: Record<string, unknown>, found = new Set<string>()): Set<string> {
  for (const segment of segments) {
    if (typeof segment === 'string')
      continue

    if (!(segment.component in components))
      found.add(segment.component)

    unknownComponents(segment.children, components, found)
  }

  return found
}
