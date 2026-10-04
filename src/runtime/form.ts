import type { TSchema } from 'elysia'

// What a top-level field's JSON schema says about the text a form posts for it.
export interface FieldSchema {
  type?: unknown
  items?: FieldSchema
  format?: unknown
  pattern?: unknown
  minLength?: unknown
  anyOf?: FieldSchema[]
}

// A checkbox posts `on` unless it has a value of its own.
const BOOLEAN_TEXT = new Map([['true', true], ['on', true], ['false', false]])
// A decimal number as a number input posts it; `Number()` alone would also read `0x10` or `Infinity`.
const DECIMAL = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i
// The string formats Elysia gives the numeric text `t.Integer()` and `t.Numeric()` also take.
const NUMERIC_FORMATS = new Set<unknown>(['integer', 'numeric'])

// A form posts text, as a query string is, and each field once per value or not at all: a top-level field is read the way its schema expects before it is validated.
// The server reads every post this way, and the browser a form it checks before posting it.
// `absentAsEmpty` reads a required list or boolean that is absent as empty or unticked, which only a form means by leaving it out.
export function formInput(schema: TSchema, body: unknown, absentAsEmpty = true): unknown {
  const { properties, required = [] } = schema as { properties?: Record<string, FieldSchema>, required?: string[] }

  if (!properties || typeof body !== 'object' || body === null)
    return body

  const fields: Record<string, unknown> = { ...body }

  for (const [name, field] of Object.entries(properties)) {
    const optional = !required.includes(name)
    const value = fields[name]

    if (value === undefined) {
      // A required list may well be empty, and an unticked checkbox posts nothing; a required file list is no file chosen, refused as missing.
      if (absentAsEmpty && !optional && ((field.type === 'array' && field.items?.format !== 'binary') || field.type === 'boolean'))
        fields[name] = field.type === 'array' ? [] : false

      continue
    }

    if (optional && value === '' && !acceptsBlank(field))
      delete fields[name]
    else if (field.type === 'array')
      fields[name] = (Array.isArray(value) ? value : [value]).map(item => fromText(field.items, item))
    else
      fields[name] = fromText(field, value)
  }

  return fields
}

// A blank input fills a plain string field; any other optional field reads it as left out.
function acceptsBlank(field: FieldSchema): boolean {
  return field.type === 'string' && field.format === undefined && field.pattern === undefined && !(typeof field.minLength === 'number' && field.minLength > 0)
}

// The number or boolean a field asks for, when the text reads as one; anything else is left for Elysia to refuse.
function fromText(field: FieldSchema | undefined, value: unknown): unknown {
  if (typeof value !== 'string')
    return value

  // Elysia would read the text with `Number()` itself, so text that is no decimal number becomes one the schema refuses.
  if (field !== undefined && isNumeric(field))
    return DECIMAL.test(value) ? Number(value) : Number.NaN

  return field?.type === 'boolean' ? BOOLEAN_TEXT.get(value) ?? value : value
}

// `t.Number()`, or `t.Integer()` and `t.Numeric()`, which Elysia writes as a number or a numeric string; `t.Date()` takes a number too, but not only.
function isNumeric(field: FieldSchema): boolean {
  return field.type === 'number' || field.type === 'integer' || (field.anyOf?.every(member => isNumeric(member) || NUMERIC_FORMATS.has(member.format)) ?? false)
}
