import type { Binding, NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { BunPlugin } from 'bun'
import { parse } from '@babel/parser'
import { loadTraverse } from '../compiler/rewrite'

interface Range {
  start: number
  end: number
}

const TRAILING_COMMA = /^\s*,/
const TS_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression'])

// `kay.config.ts` as the compiled server loads it: a build plugin and what only it imports never reach the executable, where a native addon such as Tailwind's cannot load.
export function runtimeConfig(file: string, contents: string): BunPlugin {
  return {
    name: 'kay-runtime-config',
    setup(build) {
      build.onLoad({ filter: new RegExp(`^${RegExp.escape(file)}$`) }, () => ({ contents, loader: 'ts' }))
    },
  }
}

// The config's source without the `plugins` of the object it exports by default, nor the imports and top-level declarations only they referenced; undefined when it has no such property to find.
export function withoutPlugins(source: string): string | undefined {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  let program: NodePath<t.Program> | undefined

  loadTraverse()(ast, {
    Program(path) {
      program = path
      path.stop()
    },
  })

  const config = program && exportedObject(program)
  const property = config?.properties.find(entry => entry.type !== 'SpreadElement' && !entry.computed && keyName(entry.key) === 'plugins')

  if (!program || !property)
    return undefined

  const removed: Range[] = [withTrailingComma(source, property)]
  const inside = (node: t.Node) => removed.some(range => node.start! >= range.start && node.end! <= range.end)
  const unused = (binding: Binding | undefined) => binding !== undefined && binding.referencePaths.every(reference => inside(reference.node))
  const bindings = Object.values(program.scope.bindings)

  // Dropping a declaration can leave another referenced only from it, so this runs until nothing more goes.
  for (let changed = true; changed;) {
    changed = false

    for (const binding of bindings) {
      const declaration = topLevelDeclaration(binding)

      if (!declaration || inside(declaration) || binding.referencePaths.length === 0)
        continue

      const names = declaration.type === 'ImportDeclaration' ? declaration.specifiers.map(specifier => specifier.local.name) : [binding.identifier.name]

      if (names.every(name => unused(program!.scope.getBinding(name)))) {
        removed.push(withLineEnd(source, declaration))
        changed = true
      }
    }
  }

  let stripped = source

  for (const { start, end } of removed.toSorted((a, b) => b.start - a.start))
    stripped = stripped.slice(0, start) + stripped.slice(end)

  return stripped
}

// The object literal the module exports by default, through `defineConfig(...)`, a type assertion or a top-level const.
function exportedObject(program: NodePath<t.Program>): t.ObjectExpression | undefined {
  const exported = program.node.body.find(statement => statement.type === 'ExportDefaultDeclaration')

  return exported && objectOf(exported.declaration as t.Node, program)
}

function objectOf(node: t.Node | null | undefined, program: NodePath<t.Program>): t.ObjectExpression | undefined {
  if (!node)
    return undefined

  if (node.type === 'ObjectExpression')
    return node

  if (TS_WRAPPERS.has(node.type))
    return objectOf((node as t.TSAsExpression).expression, program)

  if (node.type === 'CallExpression' && node.arguments.length === 1)
    return objectOf(node.arguments[0], program)

  if (node.type === 'Identifier') {
    const declarator = program.scope.getBinding(node.name)?.path.node

    return declarator?.type === 'VariableDeclarator' ? objectOf(declarator.init, program) : undefined
  }

  return undefined
}

function keyName(key: t.Node): string | undefined {
  return key.type === 'Identifier' ? key.name : key.type === 'StringLiteral' ? key.value : undefined
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

function withTrailingComma(source: string, node: t.Node): Range {
  const after = TRAILING_COMMA.exec(source.slice(node.end!))

  return { start: node.start!, end: node.end! + (after?.[0].length ?? 0) }
}

function withLineEnd(source: string, node: t.Node): Range {
  return { start: node.start!, end: source[node.end!] === '\n' ? node.end! + 1 : node.end! }
}
