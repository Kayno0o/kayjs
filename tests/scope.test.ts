import type { ParserOptions } from '@babel/parser'
import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Lang, Program } from '../src/compiler/estree'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import traverse, { Scope as BabelScope } from '@babel/traverse'
import { describe, expect, it } from 'bun:test'
import { parseProgram, VISITOR_KEYS } from '../src/compiler/estree'
import * as shapes from '../src/compiler/estree-shapes'
import { analyze } from '../src/compiler/scope'
import { eachDescendant, walkScope } from '../src/compiler/walk'

const ROOT = join(import.meta.dir, '..')
const PARTS = 24
const SOURCES = ['src/**/*.ts', 'tests/**/*.ts', 'packages/*/src/**/*.ts', 'docs/src/**/*.ts'].flatMap(pattern => [...new Bun.Glob(pattern).scanSync({ cwd: ROOT })]).filter(file => !file.includes('node_modules') && !file.includes('/fixtures/') && !file.includes('/.kay/'))

// Error recovery lets the parser pass what the scope refuses; a `.ts` source may hold the generic arrow `<T>(x) => x`, which a `.tsx` one reads as markup.
const parseOptions = (lang: Lang) => ({ sourceType: 'module', attachComment: false, errorRecovery: true, plugins: lang === 'tsx' ? ['typescript', 'jsx'] : ['typescript'] }) as ParserOptions

// What the rewrites ask of the scope pass, spelled the same for Babel's and kay's, which parse the same text into different trees: facts are keyed by the position of an identifier and so are the bindings, never by a node type.
interface Facts {
  // Per identifier, what its scope resolves it to, and whether it reads a value or declares a name.
  identifiers: Map<string, string[]>
  // Every binding of every scope, by its name and where it is declared.
  bindings: string[]
  globals: string[]
  // The names of bodiless class methods, which Babel reads as values, so they land among its globals.
  declareKeys: Set<string>
  error?: string
}

interface Described {
  kind: string
  constant: boolean
  identifier: { start?: number | null }
  referencePaths: { node: { start?: number | null } }[]
  constantViolations: { node: { start?: number | null } }[]
}

function describeBinding(binding: Described | undefined): string {
  return binding ? `${binding.kind}@${binding.identifier.start} constant ${binding.constant} refs ${binding.referencePaths.map(path => path.node.start).toSorted((a, b) => (a ?? 0) - (b ?? 0)).join(',')} writes ${binding.constantViolations.map(path => path.node.start).toSorted((a, b) => (a ?? 0) - (b ?? 0)).join(',')}` : 'none'
}

function note(facts: Facts, key: string, value: string) {
  facts.identifiers.set(key, [...facts.identifiers.get(key) ?? [], value].toSorted())
}

function babelFacts(code: string, lang: Lang = 'tsx'): Facts {
  const facts: Facts = { identifiers: new Map(), bindings: [], globals: [], declareKeys: new Set() }

  try {
    const file = parse(code, parseOptions(lang))

    traverse(file, {
      Identifier(path: NodePath<t.Identifier>) {
        // The name inside a `#private` is an identifier for Babel, a node of its own for oxc, and the right side of a qualified name is read as a value by Babel though no scope takes it for one.
        if (path.parent.type === 'PrivateName' || (path.parent.type === 'TSQualifiedName' && path.parent.right === path.node))
          return

        if (path.parent.type === 'TSDeclareMethod' && path.parent.key === path.node) {
          facts.declareKeys.add(path.node.name)

          return
        }

        note(facts, `${path.node.name}@${path.node.start}`, `${path.isReferencedIdentifier()} ${path.isBindingIdentifier()} ${describeBinding(path.scope.getBinding(path.node.name))}`)
      },
      Program(path: NodePath<t.Program>) {
        facts.globals = Object.keys(path.scope.globals).toSorted()
      },
      Scope(path: NodePath) {
        for (const [name, binding] of Object.entries(path.scope.bindings))
          facts.bindings.push(`${name} ${describeBinding(binding)}`)
      },
    })
  }
  catch (error) {
    facts.error = (error as Error).message
  }

  facts.bindings.sort()

  return facts
}

function kayFacts(program: Program): Facts {
  const facts: Facts = { identifiers: new Map(), bindings: [], globals: [], declareKeys: new Set() }

  try {
    const { events, program: root } = analyze(program)
    const scopes = new Set<unknown>()

    for (const path of events) {
      if (path.node.type === 'Identifier')
        note(facts, `${path.node.name}@${path.node.start}`, `${path.isReferencedIdentifier()} ${path.isBindingIdentifier()} ${describeBinding(path.scope.getBinding(path.node.name))}`)
    }

    const collect = (path: typeof root) => {
      if (!scopes.has(path.scope)) {
        scopes.add(path.scope)

        for (const [name, binding] of path.scope.bindings)
          facts.bindings.push(`${name} ${describeBinding(binding)}`)
      }

      for (const child of path.children)
        collect(child as typeof root)
    }

    collect(root)
    facts.globals = [...root.scope.globals].toSorted()
  }
  catch (error) {
    facts.error = (error as Error).message
  }

  facts.bindings.sort()

  return facts
}

// A constructor parameter property declares its name for oxc's pass, where Babel's crawl leaves it out.
const PARAMETER_PROPERTY = /\bconstructor\s*\([^)]*\b(?:public|private|protected|readonly)\b/

function compare(code: string, label: string, lang: Lang = 'tsx') {
  const { program, errors } = parseProgram(code, { lang, recover: true })

  if (errors.length > 0 || (program.body.length === 0 && code.trim() !== ''))
    return false

  const babel = babelFacts(code, lang)
  const kay = kayFacts(program)

  expect({ label, error: kay.error }).toEqual({ label, error: babel.error })

  if (babel.error !== undefined)
    return true

  if (PARAMETER_PROPERTY.test(code))
    return true

  expect({ label, globals: kay.globals }).toEqual({ label, globals: babel.globals.filter(name => !babel.declareKeys.has(name) || kay.globals.includes(name)) })
  expect({ label, bindings: kay.bindings }).toEqual({ label, bindings: babel.bindings })

  // The identifiers oxc has that Babel has not (a type parameter's name, a method's value) are left out.
  for (const [key, expected] of babel.identifiers)
    expect({ label, key, found: kay.identifiers.get(key) }).toEqual({ label, key, found: expected })

  return true
}

describe('scope pass', () => {
  // The sources are compared in parts, each a share of the files, so a slow machine keeps every test inside its timeout.
  for (let part = 0; part < PARTS; part++) {
    it(`finds the scopes, bindings, references and writes Babel does in the sources of this repository, part ${part + 1} of ${PARTS}`, () => {
      const files = SOURCES.filter((_, index) => index % PARTS === part)
      let compared = 0

      for (const file of files) {
        if (compare(readFileSync(join(ROOT, file), 'utf8'), file, file.endsWith('.tsx') ? 'tsx' : 'ts'))
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
      'function f(this: void, a: number) { type T = typeof a; return (b: typeof a) => b as typeof a }',
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
    expect(babelFacts('let a; let a').error).toContain('Duplicate declaration')

    for (const code of ['import a from "m"; const a = 1', 'let a; let a', 'const a = 1; var a', 'function f(a) { let a }', 'try {} catch (e) { let e }', 'var a; var a; function a() {}', 'export var a = 1, a = 2; a'])
      expect(compare(code, code)).toBe(true)
  })

  it('ends a walk where a handler returns stop, and visits a subtree in the order of the source without a scope', () => {
    const { program } = parseProgram('function f() { a; b } function g() { c }', { lang: 'tsx' })
    const seen: string[] = []

    expect(walkScope(program, { Identifier(path) {
      seen.push(path.node.name)

      return path.node.name === 'a' ? 'stop' : undefined
    } })).toBe(true)
    expect(seen).toEqual(['f', 'a'])

    for (const source of SOURCES.slice(0, 40)) {
      const code = readFileSync(join(ROOT, source), 'utf8')
      const babel: string[] = []
      const kay: string[] = []

      traverse(parse(code, parseOptions('ts')), { noScope: true, Identifier: (path) => {
        babel.push(`${path.node.name}@${path.node.start}`)
      } })

      const { program: tree } = parseProgram(code, { lang: 'ts', recover: true })

      eachDescendant(tree, (node) => {
        if (node.type === 'Identifier')
          kay.push(`${node.name}@${node.start}`)
      })

      // oxc names a few more identifiers than Babel does (a type parameter, a method's key position), so Babel's must be in order within kay's.
      let at = 0

      for (const name of babel) {
        at = kay.indexOf(name, at)
        expect({ source, name, at: at >= 0 }).toEqual({ source, name, at: true })
      }
    }
  })

  it('keeps the node groups to types oxc has, and the globals in step with Babel', () => {
    expect([...shapes.BUILTIN_GLOBALS].toSorted()).toEqual([...new Set([...BabelScope.globals, ...BabelScope.contextVariables])].toSorted())

    const groups = [shapes.SCOPABLE_TYPES, shapes.BLOCK_PARENT_TYPES, shapes.FUNCTION_PARENT_TYPES, shapes.FUNCTION_TYPES, shapes.PATTERN_TYPES, shapes.STATEMENT_TYPES, shapes.TS_TYPES, shapes.LOOP_TYPES]
    const known = new Set(Object.keys(VISITOR_KEYS))
    // Types a visit finds no child under are missing from oxc's keys.
    const leaves = new Set(['EmptyStatement', 'DebuggerStatement', 'BreakStatement', 'ContinueStatement', 'TSAnyKeyword', 'TSBooleanKeyword', 'TSBigIntKeyword', 'TSIntrinsicKeyword', 'TSNeverKeyword', 'TSNullKeyword', 'TSNumberKeyword', 'TSObjectKeyword', 'TSStringKeyword', 'TSSymbolKeyword', 'TSUndefinedKeyword', 'TSUnknownKeyword', 'TSVoidKeyword', 'TSThisType'])

    for (const types of groups) {
      for (const type of types)
        expect({ type, known: known.has(type) || leaves.has(type) }).toEqual({ type, known: true })
    }
  })
})
