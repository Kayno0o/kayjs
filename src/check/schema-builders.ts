import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

// Each PascalCase builder with the lowercase one that replaces it, the position of its options and the option names that changed.
const BUILDERS: Record<string, { name: string, options: number, keys?: Record<string, string> }> = {
  String: { name: 'string', options: 0, keys: { minLength: 'min', maxLength: 'max' } },
  Secret: { name: 'secret', options: 0, keys: { minLength: 'min', maxLength: 'max' } },
  Number: { name: 'number', options: 0, keys: { minimum: 'min', maximum: 'max' } },
  Numeric: { name: 'number', options: 0, keys: { minimum: 'min', maximum: 'max' } },
  Integer: { name: 'int', options: 0, keys: { minimum: 'min', maximum: 'max' } },
  Boolean: { name: 'boolean', options: 0 },
  BooleanString: { name: 'boolean', options: 0 },
  Date: { name: 'date', options: 0 },
  File: { name: 'file', options: 0 },
  Files: { name: 'files', options: 0, keys: { minItems: 'min', maxItems: 'max' } },
  Literal: { name: 'literal', options: 1 },
  Union: { name: 'union', options: 1 },
  Array: { name: 'list', options: 1, keys: { minItems: 'min', maxItems: 'max' } },
  Object: { name: 'object', options: 1 },
  UnionEnum: { name: 'enum', options: 1 },
  UnionKeys: { name: 'enum', options: 1 },
  Public: { name: 'public', options: 1 },
}

const FILES = new Set(['File', 'Files', 'file', 'files'])
const OLD_SIZE = /^\d+(?:\.\d+)?[kmg]$/i
const KAY = /^kay(?:\/|$)/
const NEEDLE = /\.(?:String|Secret|Number|Numeric|Integer|Boolean|BooleanString|Date|File|Files|Literal|Union|Array|Object|UnionEnum|UnionKeys|Public|Optional)\(|\.(?:file|files)\(/

interface Mapped {
  record: Node
  literal: Node
}

// `Object.keys(R).map(key => s.Literal(key))`, a cast on the key allowed: the record whose keys are the literals.
function mappedKeys(node: Node, receivers: Set<string>): Mapped | undefined {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.property.type !== 'Identifier' || node.callee.property.name !== 'map' || node.arguments.length !== 1)
    return undefined

  const keys = node.callee.object
  const [callback] = node.arguments

  if (keys.type !== 'CallExpression' || keys.arguments.length !== 1 || keys.callee.type !== 'MemberExpression' || keys.callee.computed || keys.callee.object.type !== 'Identifier' || keys.callee.object.name !== 'Object' || keys.callee.property.type !== 'Identifier' || keys.callee.property.name !== 'keys')
    return undefined

  const [param] = callback?.type === 'ArrowFunctionExpression' ? callback.params : []

  if (callback?.type !== 'ArrowFunctionExpression' || callback.params.length !== 1 || param?.type !== 'Identifier')
    return undefined

  const literal = builderCall(callback.body, receivers)
  let inner = literal?.node.arguments[0]

  while (inner && (inner.type === 'TSAsExpression' || inner.type === 'TSNonNullExpression'))
    inner = inner.expression

  if (literal?.name !== 'Literal' || literal.node.arguments.length !== 1 || inner?.type !== 'Identifier' || inner.name !== param.name)
    return undefined

  return { record: keys.arguments[0]!, literal: callback.body }
}

interface Call {
  node: Node & { type: 'CallExpression' }
  name: string
}

function builderCall(node: Node, receivers: Set<string>): Call | undefined {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.object.type !== 'Identifier' || node.callee.property.type !== 'Identifier')
    return undefined

  return receivers.has(node.callee.object.name) ? { node, name: node.callee.property.name } : undefined
}

function keyName(property: Node): string | undefined {
  if (property.type !== 'Property' || property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'Literal' && typeof property.key.value === 'string' ? property.key.value : undefined
}

function renamedOption(name: string, keys: Record<string, string> | undefined): string | undefined {
  return name === 'title' ? 'label' : keys?.[name]
}

// The edits renaming a builder and the options it was given under old names: `s.String({ minLength: 3 })` is `s.string({ min: 3 })`.
function renames(call: Call, base: number): Edit[] {
  const builder = BUILDERS[call.name]!
  const { property } = call.node.callee as { property: Node }
  const edits: Edit[] = [{ start: base + property.start, end: base + property.end, text: builder.name }]
  const options = call.node.arguments[builder.options]

  if (options?.type === 'ObjectExpression') {
    for (const entry of options.properties) {
      const name = keyName(entry)
      const renamed = name === undefined ? undefined : renamedOption(name, builder.keys)

      if (renamed === undefined || entry.type !== 'Property')
        continue

      edits.push({ start: base + entry.key.start, end: base + entry.key.end, text: entry.shorthand ? `${renamed}: ${name}` : renamed })
    }
  }

  return edits
}

// The options the lowercase builder needs to read as the PascalCase one did: a list takes `max` where it had none (the lowercase one stops at 1,000 items, except a list of files), and an object `extra: 'strip'` (the lowercase one refuses a key its shape lacks). Undefined when the options are not an object literal of known keys, which the fix cannot add to.
function keptOptions(call: Call): string[] | undefined {
  const index = BUILDERS[call.name]!.options
  const options = call.node.arguments[index]
  const keys = new Set<string>()

  if (options !== undefined && options.type !== 'ObjectExpression')
    return call.name === 'Array' || call.name === 'Object' ? undefined : []

  for (const entry of options?.properties ?? []) {
    const name = keyName(entry)

    if (name === undefined)
      return call.name === 'Array' || call.name === 'Object' ? undefined : []

    keys.add(name)
  }

  if (call.name === 'Object')
    return keys.has('extra') ? [] : ['extra: \'strip\'']

  if (call.name !== 'Array')
    return []

  const [item] = call.node.arguments

  return keys.has('max') || keys.has('maxItems') || (item && FILES.has(builderCallName(item))) ? [] : ['max: Number.MAX_SAFE_INTEGER']
}

function builderCallName(node: Node): string {
  return node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier' ? node.callee.property.name : ''
}

// Where options go in a builder's call: into its options object, or after its last argument. Undefined for options that are not an object literal, which the fix leaves to the app.
function addOptions(call: Call, base: number, added: string[]): Edit | undefined {
  const index = BUILDERS[call.name]!.options
  const options = call.node.arguments[index]
  const text = added.join(', ')

  if (options === undefined) {
    if (call.node.arguments.length < index)
      return undefined

    const close = base + call.node.end - 1

    return { start: close, end: close, text: call.node.arguments.length === 0 ? `{ ${text} }` : `, { ${text} }` }
  }

  if (options.type !== 'ObjectExpression')
    return undefined

  const open = base + options.start

  return { start: open, end: open + 1, text: options.properties.length === 0 ? `{ ${text} ` : `{ ${text},` }
}

type Program = Parameters<typeof importsOf>[0]
type Report = (start: number, end: number, message: string, help: string, edits: Edit[] | null) => void

// The `s` an app imported and no longer reads once a fix has taken `dropped` of its uses away: its import goes too, or the file would fail its own unused-name check.
function dropUnreadImport(ast: Program, receivers: Set<string>, dropped: number, span: { base: number, text: string }, report: Report): void {
  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || !KAY.test(statement.source.value))
      continue

    const index = statement.specifiers.findIndex(specifier => specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && (specifier.imported as { name?: string }).name === 's' && receivers.has(specifier.local.name))

    if (index < 0)
      continue

    const specifier = statement.specifiers[index]!
    let references = 0

    walk(ast, (node) => {
      if (node.type === 'Identifier' && receivers.has(node.name) && (node.start < specifier.start || node.end > specifier.end))
        references++
    })

    if (references > dropped)
      return

    const only = statement.specifiers.length === 1
    const next = statement.specifiers[index + 1]
    const previous = statement.specifiers[index - 1]
    const lineEnd = span.text[statement.end] === '\n' ? statement.end + 1 : statement.end
    // The whole line when it is the only name, else the name and the comma beside it.
    let [from, to] = [previous?.end ?? specifier.start, specifier.end]

    if (only)
      [from, to] = [statement.start, lineEnd]
    else if (next)
      [from, to] = [specifier.start, next.start]

    const edit = { start: span.base + from, end: span.base + to, text: '' }

    report(span.base + specifier.start, span.base + specifier.end, '`s` is no longer read once its builders are written as a record, so its import goes', 'drop the import of `s`', [edit])

    return
  }
}

// `defineEnv(s.Object({ ... }))`: an env reads only the names its schema declares, so the record changes nothing. True when it reported one.
function envRecord(node: Node, records: Set<string>, receivers: Set<string>, base: number, taken: Set<Node>, report: Report): boolean {
  if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || !records.has(node.callee.name))
    return false

  const [schema] = node.arguments
  const inner = schema === undefined ? undefined : builderCall(schema, receivers)
  const shape = inner?.node.arguments[0]

  if (!schema || inner?.name !== 'Object' || inner.node.arguments.length !== 1 || shape?.type !== 'ObjectExpression')
    return false

  taken.add(schema)
  report(base + schema.start, base + schema.end, 'a plain record of fields is the schema of a defineEnv since 1.106, `s.Object` being the PascalCase builder it replaces; the old form works until 2.0', 'write the record of fields', [{ start: base + schema.start, end: base + shape.start, text: '' }, { start: base + shape.end, end: base + schema.end, text: '' }])

  return true
}

// The PascalCase builders of `s`, which kay 1.106 replaces with its own lowercase ones, and the `'2m'` sizes of a file field, which are `'2mb'` as every size is.
// Found on the `s` a file imports from `kay`, in the TypeScript files and the fences of `.kay` files. `s.Optional(x)` of one of these builders is `optional: true` in its options; an `s.Array` takes `max: Number.MAX_SAFE_INTEGER` and an `s.Object` `extra: 'strip'`, which keeps what they did.
export async function schemaBuilders(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-schema-builders', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-schema-builders', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      const receivers = importsOf(ast, source => KAY.test(source), 's').locals
      const records = importsOf(ast, source => KAY.test(source), 'defineEnv').locals

      if (receivers.size === 0)
        continue

      // What an `s.Optional(...)` has taken over, so the call inside is not reported on its own.
      const taken = new Set<Node>()
      // The uses of `s` a fix takes away: an `s.Object(` of an env record.
      let dropped = 0

      walk(ast, (node) => {
        const call = builderCall(node, receivers)

        if (call === undefined) {
          if (envRecord(node, records, receivers, base, taken, report))
            dropped++

          return
        }

        if (call.name === 'Optional') {
          const [inner, ...others] = call.node.arguments
          const wrapped = inner === undefined ? undefined : builderCall(inner, receivers)
          const known = wrapped && wrapped.name !== 'Public' && BUILDERS[wrapped.name] && !taken.has(inner!)
          const kept = known ? keptOptions(wrapped) : undefined
          const edit = known && kept ? addOptions(wrapped, base, ['optional: true', ...kept]) : undefined

          // Anything but a builder of `s`, such as the `imageField()` of kay/content, has no `optional` option to write yet.
          if (!known)
            return

          if (others.length > 0 || !edit) {
            report(base + node.start, base + node.end, '`s.Optional(field)` is `optional: true` in the options of the field since 1.106, the same option on every builder; the old form works until 2.0', 'write `optional: true` in the field\'s options', null)

            return
          }

          taken.add(inner!)
          report(base + node.start, base + node.end, '`s.Optional(field)` is `optional: true` in the options of the field since 1.106, the same option on every builder; the old form works until 2.0', 'write `optional: true` in the field\'s options', [
            { start: base + node.start, end: base + inner!.start, text: '' },
            ...renames(wrapped, base),
            edit,
            { start: base + node.end - 1, end: base + node.end, text: '' },
          ])

          return
        }

        const builder = BUILDERS[call.name]

        // A mapped array is no tuple, so `s.union(...)` of one is a type error: `s.enum(record)` when it is the keys of a record, else the app writes it.
        if (call.name === 'Union' && !taken.has(node) && call.node.arguments[0]?.type !== 'ArrayExpression') {
          const mapped = call.node.arguments.length === 1 ? mappedKeys(call.node.arguments[0]!, receivers) : undefined
          const message = '`s.Union` is `s.union` since 1.106, and `s.union` takes its schemas written out as a list, so an array built at run time is a type error'
          const receiver = (call.node.callee as { object: { name: string } }).object.name

          if (mapped) {
            taken.add(mapped.literal)
            report(base + node.start, base + node.end, `${message}; \`s.enum(record)\` takes the keys of a record`, 'write `s.enum` with the record', [
              { start: base + node.start, end: base + mapped.record.start, text: `${receiver}.enum(` },
              { start: base + mapped.record.end, end: base + node.end, text: ')' },
            ])
          }
          else {
            report(base + node.start, base + node.end, `${message}; write the schemas out as a list, or \`s.enum\` for the keys of a record`, 'write the schemas as a list, or `s.enum`', null)
          }

          return
        }

        if (builder && !taken.has(node)) {
          const kept = keptOptions(call)
          const edit = kept && kept.length > 0 ? addOptions(call, base, kept) : undefined
          const object = call.name === 'Object' ? 'unknown keys are refused by `s.object` where kay reads the schema itself, where `s.Object` let them by, so the fix writes `extra: \'strip\'` to keep the old way' : ''
          const message = call.name === 'UnionKeys' || call.name === 'UnionEnum'
            ? '`s.enum()` takes the values, or a record whose keys are the values, since 1.106, in place of `s.UnionEnum` and `s.UnionKeys`; the old forms work until 2.0'
            : `\`s.${call.name}\` is \`s.${builder.name}\` since 1.106, kay's own lowercase builders with short options (\`min\`, \`max\`, \`optional\`) replacing the PascalCase ones of TypeBox${object ? `; ${object}` : ''}; the old form works until 2.0${call.name === 'Array' ? '; `s.list` is at most 1,000 items where `s.Array` had no limit, so the fix writes `max: Number.MAX_SAFE_INTEGER`' : ''}`

          // Without the option that keeps the old behaviour the rename would change it, so the fix is left to the app.
          const keeps = kept !== undefined && (kept.length === 0 || edit !== undefined)

          report(base + node.start, base + node.end, message, `write \`s.${builder.name}\``, keeps ? [...renames(call, base), ...edit ? [edit] : []] : null)
        }
      })

      walk(ast, (node) => {
        const call = builderCall(node, receivers)

        if (call === undefined || !FILES.has(call.name))
          return

        const options = call.node.arguments[0]

        if (options?.type !== 'ObjectExpression')
          return

        for (const entry of options.properties) {
          const name = keyName(entry)

          if ((name !== 'maxSize' && name !== 'minSize') || entry.type !== 'Property' || entry.value.type !== 'Literal' || typeof entry.value.value !== 'string' || !OLD_SIZE.test(entry.value.value))
            continue

          const end = base + entry.value.end - 1

          report(base + entry.value.start, base + entry.value.end, `a size is written \`'${entry.value.value}b'\`, with its unit, as every size of kay is`, 'write the size with its `b`', [{ start: end, end, text: 'b' }])
        }
      })

      if (dropped > 0)
        dropUnreadImport(ast, receivers, dropped, { base, text }, report)
    }
  })
}
