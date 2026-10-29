import type { ParserOptions } from '@babel/parser'
import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Path, Scope } from '../src/compiler/scope'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import traverse, { Scope as BabelScope } from '@babel/traverse'
import { FLIPPED_ALIAS_KEYS, VISITOR_KEYS } from '@babel/types'
import { describe, expect, it } from 'bun:test'
import * as shapes from '../src/compiler/babel-shapes'
import { analyze } from '../src/compiler/scope'
import { eachDescendant, traverse as kayTraverse, walkScope } from '../src/compiler/walk'

const ROOT = join(import.meta.dir, '..')
const PARTS = 24
const SOURCES = ['src/**/*.ts', 'tests/**/*.ts', 'packages/*/src/**/*.ts', 'docs/src/**/*.ts'].flatMap(pattern => [...new Bun.Glob(pattern).scanSync({ cwd: ROOT })]).filter(file => !file.includes('node_modules') && !file.includes('/fixtures/') && !file.includes('/.kay/'))

// Error recovery lets the parser pass what the scope refuses.
const PARSE = { sourceType: 'module', attachComment: false, errorRecovery: true, plugins: ['typescript', 'jsx'] } as ParserOptions

const EVENTS = ['Program', 'Identifier', 'CallExpression', 'ArrowFunctionExpression', 'VariableDeclarator', 'AssignmentExpression', 'UpdateExpression', 'FunctionDeclaration', 'TSTypeQuery']

function parseSource(code: string): t.File | undefined {
  try {
    return parse(code, PARSE)
  }
  catch {
    return undefined
  }
}

const where = (node: t.Node) => `${node.type}@${node.start}`

// What the rewrites ask of a path, spelled the same for Babel's and kay's.
function pathFacts(path: { node: t.Node, parentPath: { node: t.Node } | null, key: unknown, listKey?: unknown, isStatement: () => boolean, isFunction: () => boolean, isTSType: () => boolean, isReferencedIdentifier: () => boolean, getFunctionParent: () => { node: t.Node } | null }): string {
  const parent = path.parentPath ? where(path.parentPath.node) : 'none'
  const holder = path.getFunctionParent()

  return `${parent} ${String(path.key)}/${String(path.listKey)} ${path.isStatement()} ${path.isFunction()} ${path.isTSType()} ${path.isReferencedIdentifier()} ${holder ? where(holder.node) : 'none'}`
}

// What the passes ask of a scope and a binding beyond the path facts, spelled the same for both.
function nameFacts(path: { node: t.Node, scope: { hasBinding: (name: string, noGlobals?: boolean) => boolean }, isBindingIdentifier: () => boolean }, binding: { scope: { block?: t.Node, node?: t.Node } } | undefined): string {
  const { node } = path
  const owner = binding ? where((binding.scope.block ?? binding.scope.node)!) : 'none'

  return node.type === 'Identifier' ? `${path.isBindingIdentifier()} has ${path.scope.hasBinding(node.name)}/${path.scope.hasBinding(node.name, true)} declared in ${owner}` : 'not a name'
}

interface Shape {
  // Every node a traversal enters, with what the walks ask of it.
  entered: string[]
  // Per function, what a traversal under it meets, and whether each identifier under it descends from it.
  inside: string[]
  functions: string[]
  referenced: string[]
  events: string[]
  scopes: Map<string, { names: string[], bindings: string[] }>
  globals: string[]
  resolved: string[]
  error?: string
}

function describeBinding(name: string, binding: { kind: string, identifier: t.Identifier, constant: boolean, scope: { block?: t.Node, node?: t.Node }, path: { node: t.Node }, referencePaths: { node: t.Node }[], constantViolations: { node: t.Node }[] } | undefined) {
  return binding ? `${name}:${binding.kind}:${binding.identifier.start}:${binding.constant}:${where(binding.path.node)}:in ${where((binding.scope.block ?? binding.scope.node)!)}|refs ${binding.referencePaths.map(path => where(path.node)).join(',')}|writes ${binding.constantViolations.map(path => where(path.node)).join(',')}` : `${name}: none`
}

function babelShape(file: t.File): Shape {
  const shape: Shape = { entered: [], inside: [], functions: [], referenced: [], events: [], scopes: new Map(), globals: [], resolved: [] }

  try {
    const visitors: Record<string, (path: NodePath) => void> = {}

    for (const type of EVENTS) {
      visitors[type] = (path) => {
        shape.events.push(`${where(path.node)} in ${where(path.scope.block)} ${pathFacts(path)}`)

        if (type === 'Identifier')
          shape.resolved.push(describeBinding((path.node as t.Identifier).name, path.scope.getBinding((path.node as t.Identifier).name)))

        if (type === 'Program')
          shape.globals = Object.keys(path.scope.globals)
      }
    }

    visitors.Scope = (path) => {
      shape.scopes.set(where(path.scope.block), { names: Object.keys(path.scope.bindings), bindings: Object.entries(path.scope.bindings).map(([name, binding]) => describeBinding(name, binding)) })
    }

    visitors.enter = (path) => {
      const name = path.node.type === 'Identifier' ? path.node.name : undefined

      shape.entered.push(`${where(path.node)} in ${where(path.scope.block)} ${pathFacts(path)} ${nameFacts(path, name === undefined ? undefined : path.scope.getBinding(name))}`)
    }
    visitors.Function = (path) => {
      shape.functions.push(where(path.node))

      const under: string[] = []

      path.traverse({ Identifier: (inner) => {
        under.push(`${where(inner.node)} ${inner.isDescendant(path)} ${inner.find(parent => parent.isFunction())?.node.start}`)
      } })
      shape.inside.push(`${where(path.node)}: ${under.join(',')}`)
    }
    visitors.ReferencedIdentifier = (path) => {
      shape.referenced.push(where(path.node))
    }
    traverse(file, visitors)
  }
  catch (error) {
    shape.error = (error as Error).message
  }

  return shape
}

function entered(path: Path): string {
  const name = path.node.type === 'Identifier' ? path.node.name : undefined

  return `${where(path.node)} in ${where(path.scope.node)} ${pathFacts(path)} ${nameFacts(path, name === undefined ? undefined : path.scope.getBinding(name))}`
}

function kayShape(file: t.File): Shape {
  const shape: Shape = { entered: [], inside: [], functions: [], referenced: [], events: [], scopes: new Map(), globals: [], resolved: [] }

  try {
    const { events, program } = analyze(file)
    const scopes = new Set<Scope>()
    const collect = (path: Path) => {
      scopes.add(path.scope)
      for (const child of path.children)
        collect(child)
    }

    collect(program)
    walkScope(file, {
      enter: (path) => { shape.entered.push(entered(path)) },
      Function: (path) => {
        shape.functions.push(where(path.node))

        const under: string[] = []

        kayTraverse(path, { Identifier: (inner) => {
          under.push(`${where(inner.node)} ${inner.isDescendant(path)} ${inner.find(parent => parent.isFunction())?.node.start}`)
        } })
        shape.inside.push(`${where(path.node)}: ${under.join(',')}`)
      },
      ReferencedIdentifier: (path) => { shape.referenced.push(where(path.node)) },
    })

    for (const path of events) {
      shape.events.push(`${where(path.node)} in ${where(path.scope.node)} ${pathFacts(path)}`)

      if (path.node.type === 'Identifier')
        shape.resolved.push(describeBinding(path.node.name, path.scope.getBinding(path.node.name)))
    }

    shape.globals = [...program.scope.globals]

    for (const scope of scopes)
      shape.scopes.set(where(scope.node), { names: [...scope.bindings.keys()], bindings: [...scope.bindings].map(([name, binding]) => describeBinding(name, binding)) })
  }
  catch (error) {
    shape.error = (error as Error).message
  }

  return shape
}

// The Program scope is created before the visitor sees any `Scope`, so both sides list it first only by key.
function compare(code: string, label: string) {
  const file = parseSource(code)

  if (!file)
    return false

  const babel = babelShape(parse(code, PARSE))
  const kay = kayShape(file)

  expect({ label, error: kay.error }).toEqual({ label, error: babel.error })

  if (babel.error !== undefined)
    return true

  expect({ label, events: kay.events }).toEqual({ label, events: babel.events })
  expect({ label, entered: kay.entered }).toEqual({ label, entered: babel.entered })
  expect({ label, functions: kay.functions }).toEqual({ label, functions: babel.functions })
  expect({ label, inside: kay.inside }).toEqual({ label, inside: babel.inside })
  expect({ label, referenced: kay.referenced }).toEqual({ label, referenced: babel.referenced })
  expect({ label, resolved: kay.resolved }).toEqual({ label, resolved: babel.resolved })
  expect({ label, globals: [...kay.globals].sort() }).toEqual({ label, globals: [...babel.globals].sort() })

  for (const [key, expected] of babel.scopes) {
    const found = kay.scopes.get(key)

    expect({ label, key, names: found?.names }).toEqual({ label, key, names: expected.names })
    expect({ label, key, bindings: found?.bindings }).toEqual({ label, key, bindings: expected.bindings })
  }

  return true
}

describe('scope pass', () => {
  // The sources are compared in parts, each a share of the files, so a slow machine keeps every test inside its timeout.
  for (let part = 0; part < PARTS; part++) {
    it(`finds the scopes, bindings, references and writes Babel does in the sources of this repository, part ${part + 1} of ${PARTS}`, () => {
      const files = SOURCES.filter((_, index) => index % PARTS === part)
      let compared = 0

      for (const file of files) {
        if (compare(readFileSync(join(ROOT, file), 'utf8'), file))
          compared++
      }

      expect(files.length).toBeGreaterThan(0)
      expect(compared).toBe(files.length)
    })
  }

  it('follows Babel on the corners of scope', () => {
    const cases = [
      'let a = 1; { let a = 2; a++ } function f(a = b, b) { var c; return a + b + c } export const x = 1, y = f',
      'for (var i = 0; i < 3; i++) { var j = i } for (const k of [1]) k; for (var m in {}) m; for (n of []) n',
      'class A { static x = 1; [A.x]() { return A } } const B = class C { m() { return C } }; export default class D {}',
      'try { a } catch ({ message: m }) { let m2 = m } finally { var z }',
      'switch (x) { case 1: let q = 1; break; default: function w() { return q } }',
      'function f(a: number, this: void) { type T = typeof a; return (b: typeof a) => b as typeof a }',
      'import a, { b as c, type d } from "m"; import * as e from "n"; a; c; d; e; export { a as g }; export { h } from "o"',
      'const { a, b: [c, ...d], ...e } = o; ({ a, b: c } = o); [a, c] = [c, a]; delete a.b; a ||= 1',
      'var f = function g() { return g }; label: for (;;) { break label }; function h() { return arguments }',
      'const el = <Tag.Sub a={x} {...y}><div b={z} /><Other /></Tag.Sub>; <foo:bar />',
      'enum E { A = 1, B = A } namespace N { export const v = 1; var w } declare function df(a: number): void; interface I { a: typeof df }',
      'x = 1; undefinedGlobal; typeof maybe; ({ k: undefinedKey } = {}); for (var v of []) { function inner() { v } }',
      'const f = ({ a = 1 }, [b] = [a]) => a + b; function g(x = () => y, y) {}',
      'switch (find(() => a)) { case 1: let a }',
      'const __props = $props<{ a: number }>(); const { a } = __props; const el = <KayLoopFor each={a} keyed={(r) => r.id}>{(row, index) => <p>{row.x}{index}</p>}</KayLoopFor>; export const s = signal(0), m = memo(() => s() + 1); s = 2',
      'const o = { [k]: 1, get p() { return k }, m() { return k }, async *n() {} }; var k',
    ]

    for (const [index, code] of cases.entries())
      expect(compare(code, `case ${index}`)).toBe(true)
  })

  it('throws what Babel throws for a name declared twice', () => {
    expect(babelShape(parse('let a; let a', PARSE)).error).toContain('Duplicate declaration')

    for (const code of ['import a from "m"; const a = 1', 'let a; let a', 'const a = 1; var a', 'function f(a) { let a }', 'try {} catch (e) { let e }', 'var a; var a; function a() {}', 'export var a = 1, a = 2; a'])
      expect(compare(code, code)).toBe(true)
  })

  it('ends a walk where a handler returns stop, and visits a subtree in Babel\'s order without a scope', () => {
    const file = parse('function f() { a; b } function g() { c }', PARSE)
    const seen: string[] = []

    expect(walkScope(file, { Identifier(path) {
      seen.push(path.node.name)

      return path.node.name === 'a' ? 'stop' : undefined
    } })).toBe(true)
    expect(seen).toEqual(['f', 'a'])

    for (const source of SOURCES.slice(0, 40)) {
      const code = readFileSync(join(ROOT, source), 'utf8')
      const babel: string[] = []
      const kay: string[] = []

      traverse(parse(code, PARSE), { noScope: true, enter: (path) => {
        babel.push(`${where(path.node)} < ${where(path.parent)}`)
      } })
      eachDescendant(parse(code, PARSE), (node, parent) => {
        kay.push(`${where(node)} < ${where(parent)}`)
      })
      expect({ source, kay }).toEqual({ source, kay: babel })
    }
  })

  it('keeps the copied node shapes in step with @babel/types', () => {
    expect([...shapes.BUILTIN_GLOBALS].toSorted()).toEqual([...new Set([...BabelScope.globals, ...BabelScope.contextVariables])].toSorted())

    const aliases: Record<string, ReadonlySet<string>> = { Scopable: shapes.SCOPABLE_TYPES, BlockParent: shapes.BLOCK_PARENT_TYPES, FunctionParent: shapes.FUNCTION_PARENT_TYPES, Function: shapes.FUNCTION_TYPES, Pattern: shapes.PATTERN_TYPES, Method: shapes.METHOD_TYPES, Statement: shapes.STATEMENT_TYPES, TSType: shapes.TS_TYPES, Loop: shapes.LOOP_TYPES }

    for (const [alias, types] of Object.entries(aliases))
      expect([...types]).toEqual(FLIPPED_ALIAS_KEYS[alias]!)

    expect(shapes.VISITOR_KEYS).toEqual(Object.fromEntries(Object.entries(VISITOR_KEYS).filter(([, keys]) => keys.length > 0)))
  })
})
