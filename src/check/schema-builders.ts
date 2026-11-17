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
// The route options whose schema reads what a visitor or a proxy sends along with it, and so lets keys it does not name by, as `s.Object` did.
const LENIENT_KEYS = new Set(['query', 'params', 'headers', 'cookie'])
const NEEDLE = /\.(?:String|Secret|Number|Numeric|Integer|Boolean|BooleanString|Date|File|Files|Literal|Union|Array|Object|UnionEnum|UnionKeys|Public|Optional)\(|\.(?:file|files)\(/

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
function renames(call: Call, base: number, lenient = false): Edit[] {
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

  if (lenient) {
    const close = base + call.node.end - 1

    if (options === undefined)
      edits.push({ start: close, end: close, text: call.node.arguments.length === 0 ? '{}, { extra: \'strip\' }' : ', { extra: \'strip\' }' })
    else if (options.type === 'ObjectExpression')
      edits.push({ start: base + options.start + 1, end: base + options.start + 1, text: options.properties.length === 0 ? ' extra: \'strip\' ' : ' extra: \'strip\',' })
  }

  return edits
}

// Where `optional: true` goes in a builder's call: into its options object, or after its last argument. Undefined for options that are not an object literal, which the fix leaves to the app.
function optionalEdit(call: Call, base: number): Edit | undefined {
  const index = BUILDERS[call.name]!.options
  const options = call.node.arguments[index]

  if (options === undefined) {
    if (call.node.arguments.length < index)
      return undefined

    const close = base + call.node.end - 1

    return { start: close, end: close, text: call.node.arguments.length === 0 ? '{ optional: true }' : ', { optional: true }' }
  }

  if (options.type !== 'ObjectExpression')
    return undefined

  const open = base + options.start

  return { start: open, end: open + 1, text: options.properties.length === 0 ? '{ optional: true' : '{ optional: true,' }
}

// The PascalCase builders of `s`, which kay 1.106 replaces with its own lowercase ones, and the `'2m'` sizes of a file field, which are `'2mb'` as every size is.
// Found on the `s` a file imports from `kay`, in the TypeScript files and the fences of `.kay` files. `s.Optional(x)` of one of these builders is `optional: true` in its options; an `s.Object({ ... })` that is the schema of an `action` or a `defineEnv` is the record alone.
export async function schemaBuilders(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-schema-builders', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-schema-builders', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const receivers = importsOf(ast, source => KAY.test(source), 's').locals
      const records = new Set([...importsOf(ast, source => KAY.test(source), 'action').locals, ...importsOf(ast, source => KAY.test(source), 'defineEnv').locals])

      if (receivers.size === 0)
        continue

      // What an `s.Optional(...)` or a record has taken over, so the call inside is not reported on its own.
      const taken = new Set<Node>()
      const lenient = new Set<Node>()

      walk(ast, (node) => {
        if (node.type === 'Property' && !node.computed && LENIENT_KEYS.has(keyName(node) ?? ''))
          lenient.add(node.value)

        const call = builderCall(node, receivers)

        if (call === undefined) {
          // `action(s.Object({ ... }), ...)`
          if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && records.has(node.callee.name)) {
            const [schema] = node.arguments
            const inner = schema === undefined ? undefined : builderCall(schema, receivers)

            if (schema && inner?.name === 'Object' && inner.node.arguments.length === 1 && inner.node.arguments[0]!.type === 'ObjectExpression') {
              const shape = inner.node.arguments[0]

              taken.add(schema)
              report(base + schema.start, base + schema.end, 'a plain record of fields is the object schema of an action or a defineEnv since 1.106, `s.Object` being the PascalCase builder it replaces; the old form works until 2.0', 'write the record of fields', [{ start: base + schema.start, end: base + shape.start, text: '' }, { start: base + shape.end, end: base + schema.end, text: '' }])
            }
          }

          return
        }

        if (call.name === 'Optional') {
          const [inner, ...others] = call.node.arguments
          const wrapped = inner === undefined ? undefined : builderCall(inner, receivers)
          const known = wrapped && wrapped.name !== 'Public' && BUILDERS[wrapped.name] && !taken.has(inner!)
          const edit = known ? optionalEdit(wrapped, base) : undefined

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

        if (builder && !taken.has(node)) {
          const object = call.name === 'Object' ? 'unknown keys are refused as a 422 by `s.object`, where `s.Object` let them by; write `extra: \'strip\'` to keep the old way' : ''
          const message = call.name === 'UnionKeys' || call.name === 'UnionEnum'
            ? '`s.enum()` takes the values, or a record whose keys are the values, since 1.106, in place of `s.UnionEnum` and `s.UnionKeys`; the old forms work until 2.0'
            : `\`s.${call.name}\` is \`s.${builder.name}\` since 1.106, kay's own lowercase builders with short options (\`min\`, \`max\`, \`optional\`) replacing the PascalCase ones of TypeBox${object ? `; ${object}` : ''}; the old form works until 2.0`

          report(base + node.start, base + node.end, message, `write \`s.${builder.name}\``, renames(call, base, call.name === 'Object' && lenient.has(node)))
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
    }
  })
}
