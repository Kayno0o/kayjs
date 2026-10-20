import type { Node } from '@babel/types'
import { join, relative } from 'node:path'
import { parse } from '@babel/parser'
import { describe, expect, it } from 'bun:test'

const ROOT = join(import.meta.dir, '..')
const PATTERNS = (await Bun.file(join(ROOT, 'package.json')).json() as { sideEffects: string[] }).sideEffects
const GLOBS = PATTERNS.map(pattern => new Bun.Glob(pattern.replace(/^\.\//, '')))
const declared = (file: string) => GLOBS.some(glob => glob.match(file))
const transpiler = new Bun.Transpiler({ loader: 'ts', define: { 'process.env.NODE_ENV': '"production"' } })
// What a statement outside a function does when its module runs: the kinds that make a module worth keeping when nothing it exports is used.
const EFFECTS = new Set(['ExpressionStatement', 'IfStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement', 'TryStatement', 'SwitchStatement', 'ThrowStatement', 'BlockStatement', 'StaticBlock'])

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'])
// A call, an assignment or an await inside a declaration, an export or a static initializer runs as the module loads; `new` of a builtin, `Symbol.for` and a call marked pure do not count, as the bundler drops or allows them.
const EXPRESSION_EFFECTS = new Set(['CallExpression', 'NewExpression', 'OptionalCallExpression', 'AssignmentExpression', 'AwaitExpression', 'TaggedTemplateExpression'])
const BENIGN_CALLEES = new Set(['Symbol', 'Symbol.for', 'String.raw', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'URL', 'URLSearchParams', 'RegExp', 'Date', 'Error', 'TypeError', 'RangeError', 'TextEncoder', 'TextDecoder', 'Headers', 'AbortController', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int32Array', 'Float64Array', 'ArrayBuffer', 'Proxy', 'AsyncLocalStorage'])
// The initializers that call something as their module loads and are fine to drop with it: each starts with the code it names, and says why dropping it changes nothing.
const KNOWN: Record<string, [code: string, why: string][]> = {
  'await.server.ts': [['globalThis[EARLY] ??= installEarlyRejections()', 'the listener only matters to a page that awaits, which keeps the module']],
  'cache.server.ts': [['crypto.randomUUID()', 'an id for this process, read by the module\'s own functions']],
  'consent.ts': [['Object.assign(', 'adds the setters to the reader it exports']],
  'markdown.client.ts': [['new Marked(', 'builds the renderer the module\'s functions use']],
  'page-swap.ts': [['servedRoot(document)', 'reads the page\'s own markup into a map the module\'s functions use']],
  'work.ts': [['Array.from(', 'constants worked out from other constants'], ['Uint32Array.from(', 'constants worked out from other constants']],
}

function calleeName(node: Node): string {
  if (node.type === 'Identifier')
    return node.name

  if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.property.type === 'Identifier')
    return `${node.object.name}.${node.property.name}`

  return '?'
}

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'

// The KNOWN entries some initializer matched, so one left over from code that went is reported.
const matchedKnown = new Set<string>()

function calleeOf(node: Node): Node | undefined {
  if (node.type === 'TaggedTemplateExpression')
    return node.tag

  return node.type === 'CallExpression' || node.type === 'OptionalCallExpression' || node.type === 'NewExpression' ? node.callee : undefined
}

function initializerEffects(node: Node, source: string, known: string[], found: { line: number, type: string, code: string }[] = []) {
  // An instance field initializer and a method body run later; a static one and a computed key run now.
  if (FUNCTIONS.has(node.type) || (node.type === 'ClassProperty' && !node.static) || (node.type === 'ClassPrivateProperty' && !node.static))
    return found

  if (EXPRESSION_EFFECTS.has(node.type)) {
    const pure = node.leadingComments?.some(comment => (/[@#]__PURE__/).test(comment.value))
    const callee = calleeOf(node)
    const benign = callee !== undefined && BENIGN_CALLEES.has(calleeName(callee))
    const code = source.slice(node.start ?? 0, node.end ?? 0)

    const knownStart = known.find(start => code.startsWith(start))

    if (knownStart !== undefined) {
      matchedKnown.add(knownStart)

      return found
    }

    if (!pure && !benign)
      found.push({ line: node.loc?.start.line ?? 0, type: node.type, code })
  }

  for (const [key, value] of Object.entries(node) as [string, unknown][]) {
    if (key === 'loc' || key.endsWith('Comments') || typeof value !== 'object' || value === null)
      continue

    for (const child of (Array.isArray(value) ? value : [value]) as unknown[]) {
      if (isNode(child))
        initializerEffects(child, source, known, found)
    }
  }

  return found
}

// The tests, bench, examples, .kay and node_modules/.cache globs serve the repo's own apps and scratch projects, which inherit this package.json.
// A module outside the list is dropped from a bundle when nothing it exports is used, so one that registers a hook or listens to an event as it loads must be in `sideEffects` of package.json.
describe('the sideEffects of package.json', () => {
  it('names every file outside src/runtime, whose modules install hooks as they load, and the repo\'s own apps', async () => {
    const files = await Array.fromAsync(new Bun.Glob('src/**/*.{ts,kay}').scan(ROOT))
    const missing = files.filter(file => !file.startsWith('src/runtime/') && !declared(file))

    expect(missing).toEqual([])
    expect(declared('tests/fixtures/static/src/routes/index.kay')).toBe(true)
    expect(declared('bench/apps/kay/components/counter.kay')).toBe(true)
  })

  it('leaves out of the list only the modules of src/runtime with nothing running as they load, no top-level statement and no call in an initializer', async () => {
    const effects: string[] = []

    for (const file of await Array.fromAsync(new Bun.Glob('src/runtime/**/*.ts').scan(ROOT))) {
      if (file.endsWith('.d.ts') || declared(file))
        continue

      const source = transpiler.transformSync(await Bun.file(join(ROOT, file)).text())
      const program = parse(source, { sourceType: 'module' }).program
      const known = (KNOWN[relative('src/runtime', file)] ?? []).map(([code]) => code)

      for (const statement of program.body) {
        // A branch the production define turned off, which the bundler drops.
        if (statement.type === 'IfStatement' && statement.test.type === 'BooleanLiteral' && !statement.test.value)
          continue

        if (EFFECTS.has(statement.type)) {
          effects.push(`${relative('src/runtime', file)}:${statement.loc?.start.line ?? '?'} ${statement.type}`)
        }
        else {
          for (const effect of initializerEffects(statement, source, known))
            effects.push(`${relative('src/runtime', file)}:${effect.line} ${effect.type} ${effect.code.slice(0, 60)}`)
        }
      }
    }

    const unmatched = Object.values(KNOWN).flatMap(entries => entries.map(([code]) => code)).filter(code => !matchedKnown.has(code))

    expect(unmatched, 'an entry of KNOWN matching no initializer is gone from its module: remove it').toEqual([])
    expect(effects, 'a module of src/runtime running a statement as it loads goes in `sideEffects` of package.json, or the bundler drops it when nothing it exports is used').toEqual([])
  })

  it('sees a call, an assignment or an await inside an initializer, and not inside a function', () => {
    const effectsOf = (code: string) => parse(code, { sourceType: 'module' }).program.body.flatMap(statement => initializerEffects(statement, code, []).map(({ type }) => type))

    expect(effectsOf('const early = (globalThis[EARLY] ??= install())')).toEqual(['AssignmentExpression', 'CallExpression'])
    expect(effectsOf('export default listen()')).toEqual(['CallExpression'])
    expect(effectsOf('export const ready = await load()')).toEqual(['AwaitExpression', 'CallExpression'])
    expect(effectsOf('class A { static on = listen(); static [key()] = 1 }')).toEqual(['CallExpression', 'CallExpression'])
    expect(effectsOf('const registry = new Registry()')).toEqual(['NewExpression'])
    expect(effectsOf('const lazy = () => listen()\nfunction f() { listen() }\nclass A { field = listen(); method() { listen() } }')).toEqual([])
    expect(effectsOf('const id = Symbol.for("a"), m = new Map(), re = String.raw`a`, p = /* @__PURE__ */ make()')).toEqual([])
  })
})
