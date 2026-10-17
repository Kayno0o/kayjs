import type { TSchema } from 'elysia'

// What a top-level field's JSON schema says about the text a form posts for it.
export interface FieldSchema {
  type?: unknown
  items?: FieldSchema
  format?: unknown
  pattern?: unknown
  minLength?: unknown
  maxLength?: unknown
  minimum?: unknown
  maximum?: unknown
  const?: unknown
  anyOf?: FieldSchema[]
  // `false` keeps the spaces around what was typed, as a field named like a password keeps them anyway.
  trim?: unknown
}

// A checkbox posts `on` unless it has a value of its own.
const BOOLEAN_TEXT = new Map([['true', true], ['on', true], ['false', false]])
// A decimal number as a number input posts it; `Number()` alone would also read `0x10` or `Infinity`.
const DECIMAL = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i
// What a form posts for a line break, a lone carriage return included.
const CRLF = /\r\n?/g

// The string formats Elysia gives the numeric text `s.Integer()` and `s.Numeric()` also take.
export const NUMERIC_FORMATS = new Set<unknown>(['integer', 'numeric'])
// A field name holding one of these anywhere is a secret: `newPassword`, `accessToken`.
const SECRET_PART = /password|passwd|passphrase|passcode|secret|token|apikey|cvc|cvv|pass(?![a-z])/i
// These only as a whole word of the name, so `passenger` and `shipping` are echoed: `pin`, `card_number`, `apiKey`.
const SECRET_WORDS = new Set(['pass', 'pwd', 'pin', 'otp', 'ssn', 'cvc', 'cvv', 'csc', 'key', 'card', 'iban'])
// The words of a camelCase, snake_case or kebab-case name, an acronym such as `API` counting as one.
const WORD = /[A-Z]?[a-z\d]+|[A-Z]+(?![a-z])/g
// `pin2` is a pin.
const TRAILING_DIGITS = /\d+$/

// A form posts text, as a query string is, and each field once per value or not at all: a top-level field is read the way its schema expects before it is validated.
// The server reads every post this way, and the browser a form it checks before posting it.
// `form` reads the text as a form sent it: a required list or boolean absent as empty or unticked, which only a form means by leaving it out, the spaces around what was typed dropped, and an optional field left blank as left out.
export function formInput(schema: TSchema, body: unknown, form = true): unknown {
  const { properties, required = [] } = schema as { properties?: Record<string, FieldSchema>, required?: string[] }

  if (!properties || typeof body !== 'object' || body === null)
    return body

  const fields: Record<string, unknown> = { ...body }

  for (const [name, field] of Object.entries(properties)) {
    const optional = !required.includes(name)
    const value = fields[name]

    if (value === undefined) {
      // A required list may well be empty, and an unticked checkbox posts nothing; a required file list is no file chosen, refused as missing.
      if (form && !optional && ((field.type === 'array' && field.items?.format !== 'binary') || field.type === 'boolean'))
        fields[name] = field.type === 'array' ? [] : false

      continue
    }

    // Spaces around what was typed are no part of it, so `minLength` counts the text.
    const text = form && field.trim !== false && !isSecret(name) ? trimmed(value) : value

    if (optional && text === '' && (form || !acceptsBlank(field)))
      delete fields[name]
    else if (field.type === 'array')
      fields[name] = (Array.isArray(text) ? text : [text]).map(item => fromText(field.items, item))
    else
      fields[name] = fromText(field, text)
  }

  return fields
}

// A variable set to nothing fills a plain string field; any other optional field reads it as left out.
function acceptsBlank(field: FieldSchema): boolean {
  return field.type === 'string' && field.format === undefined && field.pattern === undefined && !(typeof field.minLength === 'number' && field.minLength > 0)
}

function trimmed(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(trimmed)

  return typeof value === 'string' ? value.trim() : value
}

// The number or boolean a field asks for, when the text reads as one; anything else is left for Elysia to refuse.
function fromText(field: FieldSchema | undefined, value: unknown): unknown {
  if (typeof value !== 'string')
    return value

  // Elysia would read the text with `Number()` itself, so text that is no decimal number becomes one the schema refuses.
  if (field !== undefined && isNumeric(field))
    return DECIMAL.test(value) ? Number(value) : Number.NaN

  if (field?.type === 'boolean')
    return BOOLEAN_TEXT.get(value) ?? value

  // A form posts a line break as CRLF, where the textarea the visitor typed in holds and counts it as one character: read as LF, a `maxLength` matches what the browser allowed and the text is stored as it was written.
  return value.includes('\r') ? value.replaceAll(CRLF, '\n') : value
}

// `s.Number()`, or `s.Integer()` and `s.Numeric()`, which Elysia writes as a number or a numeric string; `s.Date()` takes a number too, but not only.
function isNumeric(field: FieldSchema): boolean {
  return field.type === 'number' || field.type === 'integer' || (field.anyOf?.every(member => isNumeric(member) || NUMERIC_FORMATS.has(member.format)) ?? false)
}

// The attributes a browser checks a field against without JavaScript, where a keyword of its schema has one; `required` only where the server would refuse the field left blank, as it never does an unticked checkbox.
export function nativeConstraints(field: FieldSchema, required: boolean): [name: string, value: string][] {
  const found: [string, string][] = []

  if (required && refusesBlank(field))
    found.push(['required', ''])

  if (field.type === 'string') {
    if (typeof field.minLength === 'number' && field.minLength > 0)
      found.push(['minlength', String(field.minLength)])

    if (typeof field.maxLength === 'number')
      found.push(['maxlength', String(field.maxLength)])

    const pattern = typeof field.pattern === 'string' ? wholeValuePattern(field.pattern) : undefined

    if (pattern !== undefined)
      found.push(['pattern', pattern])

    if (field.format === 'email')
      found.push(['type', 'email'])
  }

  if (isNumeric(field)) {
    if (typeof field.minimum === 'number')
      found.push(['min', String(field.minimum)])

    if (typeof field.maximum === 'number')
      found.push(['max', String(field.maximum)])
  }

  return found
}

function refusesBlank(field: FieldSchema): boolean {
  if (field.const !== undefined)
    return field.const !== ''

  if (field.anyOf)
    return field.anyOf.length > 0 && field.anyOf.every(refusesBlank)

  if (field.type === 'string')
    return field.format !== undefined || (typeof field.minLength === 'number' && field.minLength > 0) || (typeof field.pattern === 'string' && matches(field.pattern, 'u', '') === false)

  // A required list may be empty, but not a required file list.
  if (field.type === 'array')
    return field.items?.format === 'binary'

  return field.type === 'number' || field.type === 'integer' || field.type === 'Date'
}

// A schema pattern matches anywhere in the text, where a `pattern` attribute matches all of it, read with the `v` flag: one that flag refuses would be ignored by the browser anyway.
function wholeValuePattern(pattern: string): string | undefined {
  const whole = pattern.startsWith('^') && pattern.endsWith('$') && !pattern.endsWith('\\$') ? pattern : `[\\s\\S]*(?:${pattern})[\\s\\S]*`

  return matches(whole, 'v', '') === undefined ? undefined : whole
}

// Whether the pattern matches the text, undefined for one the flag cannot read.
function matches(pattern: string, flag: 'u' | 'v', text: string): boolean | undefined {
  try {
    return new RegExp(pattern, flag).test(text)
  }
  catch {
    return undefined
  }
}

// A field never echoed back to the form, as a password is.
export function isSecret(name: string): boolean {
  return SECRET_PART.test(name) || (name.match(WORD) ?? []).some(word => SECRET_WORDS.has(word.toLowerCase().replace(TRAILING_DIGITS, '')))
}
