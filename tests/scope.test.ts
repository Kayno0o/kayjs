import type { ParserOptions } from '@babel/parser'
import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import traverse from '@babel/traverse'
import { FLIPPED_ALIAS_KEYS, VISITOR_KEYS } from '@babel/types'
import { describe, expect, it } from 'bun:test'
import * as shapes from '../src/compiler/babel-shapes'
import { analyze } from '../src/compiler/scope'

const ROOT = join(import.meta.dir, '..')
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

interface Shape {
  events: string[]
  scopes: Map<string, { names: string[], bindings: string[] }>
  globals: string[]
  resolved: string[]
  error?: string
}

function describeBinding(name: string, binding: { kind: string, identifier: t.Identifier, constant: boolean, path: { node: t.Node }, referencePaths: { node: t.Node }[], constantViolations: { node: t.Node }[] } | undefined) {
  return binding ? `${name}:${binding.kind}:${binding.identifier.start}:${binding.constant}:${where(binding.path.node)}|refs ${binding.referencePaths.map(path => where(path.node)).join(',')}|writes ${binding.constantViolations.map(path => where(path.node)).join(',')}` : `${name}: none`
}

function babelShape(file: t.File): Shape {
  const shape: Shape = { events: [], scopes: new Map(), globals: [], resolved: [] }

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

    traverse(file, visitors)
  }
  catch (error) {
    shape.error = (error as Error).message
  }

  return shape
}

function kayShape(file: t.File): Shape {
  const shape: Shape = { events: [], scopes: new Map(), globals: [], resolved: [] }

  try {
    const { events, program, scopes } = analyze(file)

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
  it('finds the scopes, bindings, references and writes Babel does in the sources of this repository', () => {
    let compared = 0

    for (const file of SOURCES) {
      if (compare(readFileSync(join(ROOT, file), 'utf8'), file))
        compared++
    }

    expect(compared).toBe(SOURCES.length)
  })

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

  it('keeps the copied node shapes in step with @babel/types', () => {
    const aliases: Record<string, ReadonlySet<string>> = { Scopable: shapes.SCOPABLE_TYPES, BlockParent: shapes.BLOCK_PARENT_TYPES, FunctionParent: shapes.FUNCTION_PARENT_TYPES, Function: shapes.FUNCTION_TYPES, Pattern: shapes.PATTERN_TYPES, Method: shapes.METHOD_TYPES, Statement: shapes.STATEMENT_TYPES, TSType: shapes.TS_TYPES, Loop: shapes.LOOP_TYPES }

    for (const [alias, types] of Object.entries(aliases))
      expect([...types]).toEqual(FLIPPED_ALIAS_KEYS[alias]!)

    expect(shapes.VISITOR_KEYS).toEqual(Object.fromEntries(Object.entries(VISITOR_KEYS).filter(([, keys]) => keys.length > 0)))
  })
})
