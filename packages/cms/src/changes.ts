import type { JsonSchema } from './kay/contract'
import type { Revision } from './revisions'
import { wording } from 'kay/words'
import { fieldsOf } from './fields'

// One field that differs between two versions of an entry, each side as short text; empty for a field that was not set.
export interface Change {
  key: string
  label: string
  before: string
  after: string
}

type Version = Pick<Revision, 'data' | 'body'>

// The most characters of a value shown on each side.
const SHOWN = 160

function shown(value: unknown): string {
  if (value === undefined || value === null)
    return ''

  const text = typeof value === 'string' ? value : JSON.stringify(value)

  return text.length > SHOWN ? `${text.slice(0, SHOWN)}…` : text
}

// The fields, and the body, that differ between two versions of an entry, in the schema's order and then the data's own for a key the schema lacks.
export function changesBetween(schema: JsonSchema, before: Version, after: Version): Change[] {
  const labels = new Map(fieldsOf(schema).map(field => [String(field.key), field.label] as const))
  const keys = new Set([...labels.keys(), ...Object.keys(before.data), ...Object.keys(after.data)])
  const found: Change[] = []

  for (const key of keys) {
    if (!Bun.deepEquals(before.data[key], after.data[key]))
      found.push({ key, label: labels.get(key) ?? key, before: shown(before.data[key]), after: shown(after.data[key]) })
  }

  if ((before.body ?? '') !== (after.body ?? ''))
    found.push({ key: '\u0001body', label: wording('cms.entry.body', 'Body'), before: shown(before.body), after: shown(after.body) })

  return found
}
