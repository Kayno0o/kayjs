import { PAYLOAD_PARAM } from '../runtime/action'
import { requestUrl } from './request-url'

// The fields the form's action URL fixes through `with()`, which stand over the ones posted under the same name.
export function withFixedFields(body: unknown, request: Request): unknown {
  const query = requestUrl(request).searchParams.get(PAYLOAD_PARAM)

  if (query === null)
    return body

  const fields: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {}
  const fixed = new Map<string, string[]>()

  for (const [name, value] of new URLSearchParams(query)) {
    // An own `__proto__` field would change the prototype of what the handler reads.
    if (name !== '__proto__')
      fixed.set(name, [...fixed.get(name) ?? [], value])
  }

  for (const [name, values] of fixed)
    fields[name] = values.length === 1 ? values[0] : values

  return fields
}

// A file input left empty still posts a nameless, empty file; dropping it lets `s.Optional(s.File())` see no file at all.
export function withoutEmptyFiles(body: unknown): unknown {
  if (typeof body !== 'object' || body === null)
    return body

  const fields: Record<string, unknown> = {}

  for (const [name, value] of Object.entries(body)) {
    if (!Array.isArray(value)) {
      if (!isEmptyFile(value))
        fields[name] = value

      continue
    }

    const files = value.filter(item => !isEmptyFile(item))

    // A multiple file input left empty posts only empty files, which is no files at all.
    if (files.length > 0 || value.length === 0)
      fields[name] = files
  }

  return fields
}

// Bun parses such a part as a Blob with no name.
function isEmptyFile(value: unknown): boolean {
  return value instanceof Blob && value.size === 0 && !(value instanceof File && value.name)
}
