import type * as t from '@babel/types'
import type { MigratedFile, Note } from './astro'
import { parse } from '@babel/parser'

// An Astro content config, `defineCollection` with a zod schema, as kay's: `collection(folder, { schema })` with the schema in `s`.

// zod's types and the `s` builder each becomes, for those that take their arguments the same way.
const SAME: Record<string, string> = { string: 'String', number: 'Number', boolean: 'Boolean', date: 'Date', array: 'Array', object: 'Object', literal: 'Literal', any: 'Any', unknown: 'Unknown', null: 'Null' }
// zod's string checks and the `s.String` option each becomes.
const STRING_CHECKS: Record<string, string> = { min: 'minLength', max: 'maxLength', email: 'format', url: 'format', regex: 'pattern' }
const LEADING_DOT_SLASH = /^\.\//
const NUMBER_CHECKS: Record<string, string> = { min: 'minimum', max: 'maximum', gte: 'minimum', lte: 'maximum' }
const CHECKS_BY_KIND = new Map([['string', STRING_CHECKS], ['number', NUMBER_CHECKS]])

class SchemaTranslator {
  readonly notes: Note[] = []

  constructor(private readonly source: string, private readonly zod: Set<string>) {}

  private text(node: t.Node): string {
    return this.source.slice(node.start!, node.end!)
  }

  private untranslated(node: t.Node, why: string): string {
    this.notes.push({ line: node.loc!.start.line, message: `${why}: left as written` })

    return `/* kay migrate: ${why} */ ${this.text(node)}`
  }

  // `z.string().min(1).optional()`: the chain read from its base call outwards.
  schema(node: t.Node): string {
    const chain: t.CallExpression[] = []
    let current: t.Node = node

    while (current.type === 'CallExpression' && current.callee.type === 'MemberExpression') {
      chain.unshift(current)
      current = current.callee.object
    }

    // The schema helper Astro passes, `schema: ({ image }) => z.object(...)`.
    if (current.type === 'CallExpression' && current.callee.type === 'Identifier' && current.callee.name === 'image')
      return chain.length === 0 ? 's.String()' : this.modifiers('s.String()', chain, node)

    const base = chain.shift()

    if (!base || base.callee.type !== 'MemberExpression' || current.type !== 'Identifier' || !this.zod.has(current.name) || base.callee.property.type !== 'Identifier')
      return this.untranslated(node, 'a schema that is not a zod call')

    const kind = base.callee.property.name
    const args = base.arguments
    let built: string
    let integer = false
    const options: string[] = []
    const checks = CHECKS_BY_KIND.get(kind)
    const rest: t.CallExpression[] = []

    for (const call of chain) {
      const name = call.callee.type === 'MemberExpression' && call.callee.property.type === 'Identifier' ? call.callee.property.name : ''
      const option = checks?.[name]

      if (option === 'format')
        options.push(`format: '${name === 'url' ? 'uri' : 'email'}'`)
      else if (option === 'pattern' && call.arguments[0]?.type === 'RegExpLiteral')
        options.push(`pattern: ${JSON.stringify(call.arguments[0].pattern)}`)
      else if (option !== undefined && call.arguments[0])
        options.push(`${option}: ${this.text(call.arguments[0])}`)
      else if (kind === 'number' && name === 'int')
        integer = true
      else
        rest.push(call)
    }

    if (kind === 'object' && args[0]?.type === 'ObjectExpression') {
      const fields = args[0].properties.map(property => property.type === 'ObjectProperty' ? `${this.text(property.key)}: ${this.schema(property.value)}` : this.untranslated(property, 'a spread in an object schema'))

      built = `s.Object({ ${fields.join(', ')} })`
    }
    else if (kind === 'array' && args[0]) {
      built = `s.Array(${this.schema(args[0])}${options.length > 0 ? `, { ${options.join(', ')} }` : ''})`
    }
    else if (kind === 'enum' && args[0]?.type === 'ArrayExpression') {
      built = `s.Union([${args[0].elements.map(element => element ? `s.Literal(${this.text(element)})` : '').join(', ')}])`
    }
    else if (kind === 'union' && args[0]?.type === 'ArrayExpression') {
      built = `s.Union([${args[0].elements.map(element => element ? this.schema(element) : '').join(', ')}])`
    }
    else if (kind === 'coerce' || !(kind in SAME)) {
      return this.untranslated(node, `z.${kind} has no \`s\` counterpart kay migrate knows`)
    }
    else {
      const builder = integer ? 's.Integer' : `s.${SAME[kind]}`

      built = `${builder}(${[...args.map(arg => this.text(arg)), ...options.length > 0 ? [`{ ${options.join(', ')} }`] : []].join(', ')})`
    }

    return this.modifiers(built, rest, node)
  }

  private modifiers(built: string, calls: t.CallExpression[], node: t.Node): string {
    let result = built

    for (const call of calls) {
      const name = call.callee.type === 'MemberExpression' && call.callee.property.type === 'Identifier' ? call.callee.property.name : ''

      if (name === 'optional' || name === 'nullish')
        result = `s.Optional(${result})`
      else if (name === 'nullable')
        result = `s.Nullable(${result})`
      else if (name === 'default' && call.arguments[0])
        result = result.endsWith(')') && !result.startsWith('s.Optional(') ? `${result.slice(0, -1)}${result.endsWith('()') ? '' : ', '}{ default: ${this.text(call.arguments[0])} })` : this.untranslated(node, '`.default` on a schema already given options')
      else
        return this.untranslated(node, `.${name}() has no \`s\` counterpart kay migrate knows`)
    }

    return result
  }
}

function literalKey(key: t.Node): string | undefined {
  if (key.type === 'Identifier')
    return key.name

  return key.type === 'StringLiteral' ? key.value : undefined
}

function callOf(node: t.Node | undefined): t.CallExpression | undefined {
  return node?.type === 'CallExpression' ? node : undefined
}

// The folder a collection's entries are in, relative to the config: the `glob` loader's `base`, else Astro's `src/content/<name>`.
function folderOf(options: t.ObjectExpression, name: string): string | undefined {
  const loader = options.properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && property.key.type === 'Identifier' && property.key.name === 'loader')

  if (!loader)
    return `content/${name}`

  if (loader.value.type !== 'CallExpression' || loader.value.callee.type !== 'Identifier' || loader.value.callee.name !== 'glob' || loader.value.arguments[0]?.type !== 'ObjectExpression')
    return undefined

  const base = loader.value.arguments[0].properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && property.key.type === 'Identifier' && property.key.name === 'base')

  if (base?.value.type !== 'StringLiteral')
    return undefined

  // Astro's `base` is relative to the project root, kay's folder to the config in `src/`.
  const folder = base.value.value.replace(LEADING_DOT_SLASH, '')

  return folder.startsWith('src/') ? folder.slice(4) : `../${folder}`
}

export function migrateContentConfig(source: string): Pick<MigratedFile, 'code' | 'notes'> {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  const zod = new Set<string>()
  const translator = new SchemaTranslator(source, zod)
  const notes: Note[] = []
  const collections: string[] = []
  const kept: string[] = []
  const declared = new Map<string, t.CallExpression>()

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') {
      if (['astro:content', 'astro/zod', 'astro/loaders', 'zod'].includes(statement.source.value)) {
        for (const specifier of statement.specifiers) {
          if (specifier.local.name === 'z' || (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && specifier.imported.name === 'z'))
            zod.add(specifier.local.name)
        }
      }
      else {
        kept.push(source.slice(statement.start!, statement.end!))
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
          kept.push(source.slice(statement.start!, statement.end!))
      }
    }
    else if (statement.type !== 'ExportNamedDeclaration' || statement.declaration) {
      kept.push(source.slice(statement.start!, statement.end!))
    }
  }

  const code = [
    `import { s } from 'kay'\nimport { collection } from 'kay/content'`,
    ...kept,
    ...collections,
  ].join('\n\n')

  return { code: `${code}\n`, notes: [...notes, ...translator.notes].toSorted((a, b) => a.line - b.line) }
}

function collectionsOf(object: t.ObjectExpression, declared: Map<string, t.CallExpression>, translator: SchemaTranslator, notes: Note[], source: string): string[] {
  const result: string[] = []

  for (const property of object.properties) {
    if (property.type !== 'ObjectProperty' && property.type !== 'ObjectMethod')
      continue

    const name = literalKey(property.key)
    const value = property.type === 'ObjectProperty' ? property.value : undefined
    const call = value?.type === 'Identifier' ? declared.get(value.name) : callOf(value)

    if (name === undefined || name === '' || !call || call.arguments[0]?.type !== 'ObjectExpression') {
      notes.push({ line: property.loc!.start.line, message: `the collection ${name ?? source.slice(property.start!, property.end!)} is not a \`defineCollection({...})\` kay migrate reads: write it by hand` })

      continue
    }

    const options = call.arguments[0]
    const folder = folderOf(options, name)
    const schemaProperty = options.properties.find((option): option is t.ObjectProperty => option.type === 'ObjectProperty' && option.key.type === 'Identifier' && option.key.name === 'schema')
    let schema = schemaProperty?.value

    // `schema: ({ image }) => z.object(...)`: an image is its URL in kay.
    if (schema?.type === 'ArrowFunctionExpression' && schema.body.type !== 'BlockStatement')
      schema = schema.body

    if (folder === undefined)
      notes.push({ line: call.loc!.start.line, message: `the collection ${name} uses a loader other than \`glob({ base })\`: kay reads a folder of files, so give it the folder` })

    result.push(`export const ${name} = collection('${folder ?? `content/${name}`}', {\n  schema: ${schema ? translator.schema(schema) : 's.Object({})'},\n})`)
  }

  return result
}
