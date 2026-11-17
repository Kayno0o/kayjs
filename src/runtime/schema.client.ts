import type { s as server } from './schema'

// The symbols TypeBox reads a schema and an optional field by, which `isSchema` and `schemaOf` read here as well.
const KIND = Symbol.for('TypeBox.Kind')
const OPTIONAL = Symbol.for('TypeBox.Optional')

type Node = Record<PropertyKey, unknown>
type Options = Record<string, unknown> | undefined

const DEFAULT_MAX_LENGTH = 10_000
const DEFAULT_MAX_ITEMS = 1000
const SLUG = '^[a-z0-9]+(?:-[a-z0-9]+)*$'
const FIELD_KEYS = new Set(['optional', 'default', 'error', 'label', 'description', 'example'])

// The JSON Schema a builder stands for, the same keywords the server's builders write, so a schema shared with an island is read by `validate` there: the chunk of the validator is in the page only where `validate` is called, and a module that only builds its schemas costs these few functions.
function node(kind: string, keywords: Node, options: Options): Node {
  const field: Node = { [KIND]: kind, ...keywords }
  const { default: fallback, error, label, description, example } = options ?? {}

  if (fallback !== undefined)
    field.default = fallback

  if (error !== undefined)
    field.error = error

  if (label !== undefined)
    field.title = label

  if (description !== undefined)
    field.description = description

  if (example !== undefined)
    field.examples = [example]

  for (const [key, value] of Object.entries(options ?? {})) {
    if (!FIELD_KEYS.has(key) && !(key in field) && !['min', 'max', 'pattern', 'extra', 'minSize', 'maxSize', 'type'].includes(key))
      field[key] = value
  }

  if (options?.optional === true)
    field[OPTIONAL] = 'Optional'

  return field
}

function text(options: Options, extra: Node = {}): Node {
  const pattern = options?.pattern instanceof RegExp ? options.pattern.source : options?.pattern
  const max = options?.max ?? options?.maxLength

  return { type: 'string', ...extra, ...options?.min !== undefined && { minLength: options.min }, maxLength: max ?? DEFAULT_MAX_LENGTH, ...pattern !== undefined && { pattern } }
}

function numbers(type: string, options: Options): Node {
  return { type, ...options?.min !== undefined && { minimum: options.min }, ...options?.max !== undefined && { maximum: options.max } }
}

function objectOf(shape: Record<string, Node>, options: Options): Node {
  const required = Object.keys(shape).filter(name => !(OPTIONAL in shape[name]!))

  return node('Object', {
    type: 'object',
    properties: { ...shape },
    ...required.length > 0 && { required },
    ...options?.extra === 'strip' ? { 'x-kay-extra': 'strip' } : { additionalProperties: false },
  }, options)
}

function enumeration(source: readonly unknown[] | object, options: Options): Node {
  const values = Array.isArray(source) ? source : Object.keys(source)
  const labels = Array.isArray(source) ? [] : Object.entries(source).filter(([, label]) => typeof label === 'string')

  return node('Union', { type: typeof values[0] === 'number' ? 'number' : 'string', enum: values, ...labels.length > 0 && { 'x-labels': Object.fromEntries(labels) } }, options)
}

function filesOf(options: Options, many: boolean): Node {
  const item = { type: 'string', format: 'binary', ...options?.type !== undefined && { extension: options.type }, ...options?.minSize !== undefined && { minSize: options.minSize }, ...options?.maxSize !== undefined && { maxSize: options.maxSize } }

  return many ? { type: 'array', items: item, ...options?.min !== undefined && { minItems: options.min }, ...options?.max !== undefined && { maxItems: options.max } } : item
}

const builders: Record<string, (...args: never[]) => Node> = {
  string: (options?: Options) => node('String', text(options), options),
  email: (options?: Options) => node('String', text({ max: 254, ...options }, { format: 'email' }), options),
  url: (options?: Options) => node('String', text({ max: 2048, ...options }, { format: 'url' }), options),
  slug: (options?: Options) => node('String', text({ max: 200, ...options, pattern: SLUG }), options),
  secret: (options?: Options) => node('String', text({ ...options, min: Math.max(32, (options?.min as number | undefined) ?? 0) }, { secret: true }), options),
  int: (options?: Options) => node('Integer', numbers('integer', options), options),
  number: (options?: Options) => node('Number', numbers('number', options), options),
  boolean: (options?: Options) => node('Boolean', { type: 'boolean' }, options),
  date: (options?: Options) => node('Date', { type: 'string', format: 'date-time' }, options),
  enum: enumeration,
  literal: (value: unknown, options?: Options) => node('Literal', { const: value }, options),
  union: (members: Node[], options?: Options) => node('Union', { anyOf: [...members] }, options),
  object: objectOf,
  record: (value: Node, options?: Options) => node('Record', { type: 'object', additionalProperties: value }, options),
  list: (item: Node, options?: Options) => node('Array', { type: 'array', items: item, ...options?.min !== undefined && { minItems: options.min }, ...(options?.max ?? options?.maxItems) !== undefined ? { maxItems: options?.max ?? options?.maxItems } : item.format !== 'binary' && { maxItems: DEFAULT_MAX_ITEMS } }, options),
  file: (options?: Options) => node('File', filesOf(options, false), options),
  files: (options?: Options) => node('Files', filesOf(options, true), options),
  public: (field: Node) => ({ ...field, public: true }),
  Optional: (field: Node) => ({ ...field, [OPTIONAL]: 'Optional' }),
}

// The builders of 1.105 and before reach the browser as an opaque schema that accepts anything, so a module shared with an island still loads.
const opaque = (): Node => ({ [KIND]: 'Any' })

// The browser's `s`: it builds the plain JSON Schema `validate` reads, and carries no Elysia, which would weigh about 190 KB in every island. Unused, a bundler drops it.
export const s = /* @__PURE__ */ new Proxy({}, {
  get: (_, name) => {
    if (typeof name === 'symbol' || name === 'then')
      return undefined

    return Object.hasOwn(builders, name) ? builders[name] : opaque
  },
}) as typeof server
