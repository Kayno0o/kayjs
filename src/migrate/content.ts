import type { CallExpression, Node, ObjectExpression, ObjectProperty } from 'oxc-parser'
import type { MigratedFile, Note } from './astro'
import { parseProgram, positionOf } from '../compiler/estree'

// An Astro content config, `defineCollection` with a zod schema, as kay's: `collection(folder, { schema })` with the schema in `s`.

// zod's types and the `s` builder each becomes, for those that take their arguments the same way.
const SAME: Record<string, string> = { string: 'string', number: 'number', boolean: 'boolean', date: 'date', literal: 'literal' }
// zod's string checks and the `s.string` option each becomes.
const STRING_CHECKS: Record<string, string> = { min: 'min', max: 'max', email: 'format', url: 'format', regex: 'pattern' }
const LEADING_DOT_SLASH = /^\.\//
const NUMBER_CHECKS: Record<string, string> = { min: 'min', max: 'max', gte: 'min', lte: 'max' }
const CHECKS_BY_KIND = new Map([['string', STRING_CHECKS], ['number', NUMBER_CHECKS]])

class SchemaTranslator {
  readonly notes: Note[] = []

  constructor(private readonly source: string, private readonly zod: Set<string>) {}

  private text(node: Node): string {
    return this.source.slice(node.start, node.end)
  }

  private untranslated(node: Node, why: string): string {
    this.notes.push({ line: positionOf(this.source, node.start).line, message: `${why}: left as written` })

    return `/* kay migrate: ${why} */ ${this.text(node)}`
  }

  // `z.string().min(1).optional()`: the chain read from its base call outwards.
  schema(node: Node): string {
    const chain: CallExpression[] = []
    let current: Node = node

    while (current.type === 'CallExpression' && current.callee.type === 'MemberExpression') {
      chain.unshift(current)
      current = current.callee.object
    }

    // The schema helper Astro passes, `schema: ({ image }) => z.object(...)`.
    if (current.type === 'CallExpression' && current.callee.type === 'Identifier' && current.callee.name === 'image')
      return this.image(chain, node)

    const base = chain.shift()

    if (!base || base.callee.type !== 'MemberExpression' || current.type !== 'Identifier' || !this.zod.has(current.name) || base.callee.property.type !== 'Identifier')
      return this.untranslated(node, 'a schema that is not a zod call')

    const kind = base.callee.property.name
    const args = base.arguments
    const { options, integer, rest } = this.chain(kind, chain)

    if (rest[0])
      return this.untranslated(node, `.${methodName(rest[0])}() has no \`s\` counterpart kay migrate knows`)

    if (kind === 'object' && args[0]?.type === 'ObjectExpression') {
      const fields = args[0].properties.map(property => isPlain(property) ? `${this.text(property.key)}: ${this.schema(property.value)}` : this.untranslated(property, 'a spread in an object schema'))

      return this.call('s.object', [`{ ${fields.join(', ')} }`], options)
    }

    if (kind === 'array' && args[0])
      return this.call('s.list', [this.schema(args[0])], options)

    if (kind === 'enum' && args[0]?.type === 'ArrayExpression')
      return this.call('s.enum', [this.text(args[0])], options)

    if (kind === 'union' && args[0]?.type === 'ArrayExpression')
      return this.call('s.union', [`[${args[0].elements.map(element => element ? this.schema(element) : '').join(', ')}]`], options)

    if (kind === 'coerce' || !(kind in SAME))
      return this.untranslated(node, `z.${kind} has no \`s\` counterpart kay migrate knows`)

    return this.call(integer ? 's.int' : `s.${SAME[kind]}`, args.map(arg => this.text(arg)), options)
  }

  // The `image()` helper: a string, whatever follows it in the chain.
  private image(chain: CallExpression[], node: Node): string {
    const { options, rest } = this.chain('image', chain)

    return rest[0] ? this.untranslated(node, `.${methodName(rest[0])}() has no \`s\` counterpart kay migrate knows`) : this.call('s.string', [], options)
  }

  // `s.string({ min: 1 })`: the builder, its arguments, then the options when there are any.
  private call(builder: string, args: string[], options: string[]): string {
    return `${builder}(${[...args, ...options.length > 0 ? [`{ ${options.join(', ')} }`] : []].join(', ')})`
  }

  // The calls after a zod type: the checks that are options of the builder, `.optional()` and `.default()`, and what has no counterpart.
  private chain(kind: string, chain: CallExpression[]): { options: string[], integer: boolean, rest: CallExpression[] } {
    const checks = CHECKS_BY_KIND.get(kind)
    const options: string[] = []
    const rest: CallExpression[] = []
    let integer = false

    for (const call of chain) {
      const name = methodName(call)
      const option = checks?.[name]
      const first = call.arguments[0]

      if (option === 'format')
        options.push(`format: '${name === 'url' ? 'uri' : 'email'}'`)
      else if (option === 'pattern' && first?.type === 'Literal' && 'regex' in first)
        options.push(`pattern: ${JSON.stringify((first as { regex: { pattern: string } }).regex.pattern)}`)
      else if (option !== undefined && first)
        options.push(`${option}: ${this.text(first)}`)
      else if (kind === 'number' && name === 'int')
        integer = true
      else if (name === 'optional' || name === 'nullish')
        options.push('optional: true')
      else if (name === 'default' && first)
        options.push(`default: ${this.text(first)}`)
      else
        rest.push(call)
    }

    return { options, integer, rest }
  }
}

function methodName(call: CallExpression): string {
  return call.callee.type === 'MemberExpression' && call.callee.property.type === 'Identifier' ? call.callee.property.name : ''
}

function literalKey(key: Node): string | undefined {
  if (key.type === 'Identifier')
    return key.name

  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined
}

// An `key: value` entry of an object, which is neither a method, an accessor nor a spread.
function isPlain(node: Node): node is ObjectProperty {
  return node.type === 'Property' && node.kind === 'init' && !node.method
}

function callOf(node: Node | undefined): CallExpression | undefined {
  return node?.type === 'CallExpression' ? node : undefined
}

// The folder a collection's entries are in, relative to the config: the `glob` loader's `base`, else Astro's `src/content/<name>`.
function folderOf(options: ObjectExpression, name: string): string | undefined {
  const loader = options.properties.find((property): property is ObjectProperty => isPlain(property) && property.key.type === 'Identifier' && property.key.name === 'loader')

  if (!loader)
    return `content/${name}`

  if (loader.value.type !== 'CallExpression' || loader.value.callee.type !== 'Identifier' || loader.value.callee.name !== 'glob' || loader.value.arguments[0]?.type !== 'ObjectExpression')
    return undefined

  const base = loader.value.arguments[0].properties.find((property): property is ObjectProperty => isPlain(property) && property.key.type === 'Identifier' && property.key.name === 'base')

  if (base?.value.type !== 'Literal' || typeof base.value.value !== 'string')
    return undefined

  // Astro's `base` is relative to the project root, kay's folder to the config in `src/`.
  const folder = base.value.value.replace(LEADING_DOT_SLASH, '')

  return folder.startsWith('src/') ? folder.slice(4) : `../${folder}`
}

export function migrateContentConfig(source: string): Pick<MigratedFile, 'code' | 'notes'> {
  const { program } = parseProgram(source)
  const zod = new Set<string>()
  const translator = new SchemaTranslator(source, zod)
  const notes: Note[] = []
  const collections: string[] = []
  const kept: string[] = []
  const declared = new Map<string, CallExpression>()

  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      if (['astro:content', 'astro/zod', 'astro/loaders', 'zod'].includes(statement.source.value)) {
        for (const specifier of statement.specifiers) {
          if (specifier.local.name === 'z' || (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && specifier.imported.name === 'z'))
            zod.add(specifier.local.name)
        }
      }
      else {
        kept.push(source.slice(statement.start, statement.end))
      }

      continue
    }

    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type !== 'Identifier' || !declarator.init)
          continue

        if (declarator.init.type === 'CallExpression' && declarator.init.callee.type === 'Identifier' && declarator.init.callee.name === 'defineCollection')
          declared.set(declarator.id.name, declarator.init)
        else if (declarator.id.name === 'collections' && declarator.init.type === 'ObjectExpression')
          collections.push(...collectionsOf(declarator.init, declared, translator, notes, source))
        else
          kept.push(source.slice(statement.start, statement.end))
      }
    }
    else if (statement.type !== 'ExportNamedDeclaration' || statement.declaration) {
      kept.push(source.slice(statement.start, statement.end))
    }
  }

  const code = [
    `import { s } from 'kay'\nimport { collection } from 'kay/content'`,
    ...kept,
    ...collections,
  ].join('\n\n')

  return { code: `${code}\n`, notes: [...notes, ...translator.notes].toSorted((a, b) => a.line - b.line) }
}

function collectionsOf(object: ObjectExpression, declared: Map<string, CallExpression>, translator: SchemaTranslator, notes: Note[], source: string): string[] {
  const result: string[] = []

  for (const property of object.properties) {
    if (property.type !== 'Property')
      continue

    const name = literalKey(property.key)
    const value = property.method || property.kind !== 'init' ? undefined : property.value
    const call = value?.type === 'Identifier' ? declared.get(value.name) : callOf(value)

    if (name === undefined || name === '' || !call || call.arguments[0]?.type !== 'ObjectExpression') {
      notes.push({ line: positionOf(source, property.start).line, message: `the collection ${name ?? source.slice(property.start, property.end)} is not a \`defineCollection({...})\` kay migrate reads: write it by hand` })

      continue
    }

    const options = call.arguments[0]
    const folder = folderOf(options, name)
    const schemaProperty = options.properties.find((option): option is ObjectProperty => isPlain(option) && option.key.type === 'Identifier' && option.key.name === 'schema')
    let schema = schemaProperty?.value

    // `schema: ({ image }) => z.object(...)`: an image is its URL in kay.
    if (schema?.type === 'ArrowFunctionExpression' && schema.body.type !== 'BlockStatement')
      schema = schema.body

    if (folder === undefined)
      notes.push({ line: positionOf(source, call.start).line, message: `the collection ${name} uses a loader other than \`glob({ base })\`: kay reads a folder of files, so give it the folder` })

    result.push(`export const ${name} = collection('${folder ?? `content/${name}`}', {\n  schema: ${schema ? translator.schema(schema) : 's.object({})'},\n})`)
  }

  return result
}
