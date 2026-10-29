import type * as t from '@babel/types'
import type { Binding } from '../compiler/scope'
import { basename, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from '@babel/parser'
import { constBindings, exportedObject } from '../compiler/object-literal'
import { analyze } from '../compiler/scope'
import { eachDescendant } from '../compiler/walk'

interface Range {
  start: number
  end: number
}

interface Token extends Range {
  type: string | { label: string }
}

const COMMENTS = new Set(['CommentBlock', 'CommentLine'])

// The config's source without the `plugins` of the object it exports by default, nor the imports and top-level declarations only they referenced; undefined when they cannot be told apart from the rest.
// A declaration referencing itself, or one a type mentions, stays: what is left must run as it did.
export function withoutPlugins(source: string): string | undefined {
  const ast = parseModule(source, true)

  if (!ast)
    return undefined

  const { program } = analyze(ast)
  const config = exportedObject(program.node, constBindings(program.node, true))

  // A spread may carry plugins of its own.
  if (!config || config.properties.some(entry => entry.type === 'SpreadElement'))
    return undefined

  const properties = config.properties.filter(entry => entry.type !== 'SpreadElement' && !entry.computed && keyName(entry.key) === 'plugins')

  if (properties.length === 0)
    return undefined

  const { scope } = program
  const tokens = (ast.tokens ?? []) as Token[]
  const removed: Range[] = properties.map(property => withTrailingComma(tokens, property))
  const inside = (node: t.Node) => removed.some(range => node.start! >= range.start && node.end! <= range.end)
  const unused = (binding: Binding | undefined) => binding !== undefined && binding.referencePaths.every(reference => inside(reference.node))
  const bindings = [...scope.bindings.values()]

  // Dropping a declaration can leave another referenced only from it, so this runs until nothing more goes.
  for (let changed = true; changed;) {
    changed = false

    for (const binding of bindings) {
      const declaration = topLevelDeclaration(binding)

      if (!declaration || inside(declaration) || binding.referencePaths.length === 0)
        continue

      // Every name the statement declares, a destructuring's included, must go for it to go.
      const names = declaration.type === 'ImportDeclaration' ? declaration.specifiers.map(specifier => specifier.local.name) : Object.keys(binding.path.getBindingIdentifiers())

      if (names.every(name => unused(scope.getBinding(name)))) {
        removed.push(withLineEnd(source, declaration))
        changed = true
      }
    }
  }

  let stripped = source

  for (const { start, end } of removed.toSorted((a, b) => b.start - a.start))
    stripped = stripped.slice(0, start) + stripped.slice(end)

  return parseModule(stripped, false) ? stripped : undefined
}

// The source with the `import.meta` paths of the module written out as the file's, so a config reading a file beside it at load, as `readdirSync(join(import.meta.dir, '../llms'))`, finds it where the build did instead of in the executable's own file system.
// `new URL('./file', import.meta.url)` stays: it names a file the build ships.
export function withProjectPaths(source: string, file: string): string {
  const ast = parseModule(source, false)
  const paths: Record<string, string> = { dir: dirname(file), dirname: dirname(file), path: file, filename: file, file: basename(file), url: pathToFileURL(file).href }
  const found: (Range & { value: string })[] = []

  if (!ast)
    return source

  eachDescendant(ast, (node, parent) => {
    if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression')
      return

    const { object, property, computed } = node
    const name = memberName(property, computed)

    if (object.type !== 'MetaProperty' || object.meta.name !== 'import' || name === undefined || !Object.hasOwn(paths, name) || (name === 'url' && namesShippedFile(node, parent)))
      return

    found.push({ start: node.start!, end: node.end!, value: paths[name]! })
  })

  let pinned = source

  for (const { start, end, value } of found.toSorted((a, b) => b.start - a.start))
    pinned = pinned.slice(0, start) + JSON.stringify(value) + pinned.slice(end)

  return pinned
}

// `.dir` or `['dir']`.
function memberName(property: t.Node, computed: boolean): string | undefined {
  if (property.type === 'Identifier' && !computed)
    return property.name

  return property.type === 'StringLiteral' ? property.value : undefined
}

// `import.meta.url` as the base of `new URL('./file', ...)`.
function namesShippedFile(node: t.Node, call: t.Node): boolean {
  return call.type === 'NewExpression' && call.callee.type === 'Identifier' && call.callee.name === 'URL' && call.arguments[1] === node && call.arguments[0]?.type === 'StringLiteral'
}

// Undefined for what Babel does not read, though Bun might: the config then goes in as it is.
function parseModule(source: string, tokens: boolean): ReturnType<typeof parse> | undefined {
  try {
    return parse(source, { sourceType: 'module', plugins: ['typescript'], tokens })
  }
  catch {
    return undefined
  }
}

function keyName(key: t.Node): string | undefined {
  if (key.type === 'Identifier')
    return key.name

  return key.type === 'StringLiteral' ? key.value : undefined
}

// The whole statement declaring a binding at the top of the module, one a named export does not hand out.
function topLevelDeclaration(binding: Binding): t.Statement | undefined {
  const { path } = binding

  if (binding.kind === 'module')
    return path.parentPath?.node.type === 'ImportDeclaration' ? path.parentPath.node : undefined

  const statement = path.node.type === 'VariableDeclarator' ? path.parentPath : path

  if (statement?.parentPath?.node.type !== 'Program')
    return undefined

  const node = statement.node as t.Statement

  return node.type === 'FunctionDeclaration' || (node.type === 'VariableDeclaration' && node.declarations.length === 1) ? node : undefined
}

// The property and the comma after it, past any comment between them.
function withTrailingComma(tokens: Token[], node: t.Node): Range {
  const next = tokens.find(token => token.start >= node.end! && !(typeof token.type === 'string' && COMMENTS.has(token.type)))
  const comma = typeof next?.type === 'object' && next.type.label === ','

  return { start: node.start!, end: comma ? next.end : node.end! }
}

function withLineEnd(source: string, node: t.Node): Range {
  return { start: node.start!, end: source[node.end!] === '\n' ? node.end! + 1 : node.end! }
}
