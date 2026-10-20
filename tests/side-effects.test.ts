import type { Node, VariableDeclarator } from '@babel/types'
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
// A class member whose value runs later when it is not static: its computed key still runs as the class is defined.
const INSTANCE_FIELDS = new Set(['ClassProperty', 'ClassPrivateProperty', 'ClassAccessorProperty'])
// A call, an assignment, an increment, a `delete` or an await inside a declaration, an export or a static initializer runs as the module loads; `new` of a builtin, `Symbol.for` and a call marked pure do not count, as the bundler drops or allows them.
const EXPRESSION_EFFECTS = new Set(['CallExpression', 'NewExpression', 'OptionalCallExpression', 'AssignmentExpression', 'UpdateExpression', 'AwaitExpression', 'TaggedTemplateExpression'])
const BENIGN_CALLEES = new Set(['Symbol', 'Symbol.for', 'String.raw', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'URL', 'URLSearchParams', 'RegExp', 'Date', 'Error', 'TypeError', 'RangeError', 'TextEncoder', 'TextDecoder', 'Headers', 'AbortController', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int32Array', 'Float64Array', 'ArrayBuffer', 'Proxy', 'AsyncLocalStorage'])
// The declarations whose initializer calls something as the module loads and is fine to drop with it: the declared name and the start of its whole initializer, so no other call of the file is exempt, and why dropping it changes nothing.
const KNOWN: Record<string, [name: string, initializer: string, why: string][]> = {
  'await.server.ts': [['early', 'globalThis[EARLY] ??= installEarlyRejections()', 'the listener only matters to a page that awaits, which keeps the module']],
  'cache.server.ts': [['PROCESS', 'crypto.randomUUID()', 'an id for this process, read by the module\'s own functions']],
  'consent.ts': [['consent', 'Object.assign(', 'adds the setters to the reader it exports']],
  'markdown.client.ts': [['marked', 'new Marked(', 'builds the renderer the module\'s functions use']],
  'page-swap.ts': [['served', 'typeof document === "undefined" ? new Map : servedRoot(document)', 'reads the page\'s own markup into a map the module\'s functions use']],
  'work.ts': [
    ['PRIMES', 'Array.from(', 'constants worked out from other constants'],
    ['ROUNDS', 'Uint32Array.from(PRIMES,', 'constants worked out from other constants'],
    ['START', 'Uint32Array.from(PRIMES.slice(0, 8),', 'constants worked out from other constants'],
  ],
}

function calleeName(node: Node): string {
  if (node.type === 'Identifier')
    return node.name

  if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.property.type === 'Identifier')
    return `${node.object.name}.${node.property.name}`

  return '?'
}

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'

// The KNOWN entries some declaration matched, so one left over from code that went is reported.
const matchedKnown = new Set<readonly string[]>()

function calleeOf(node: Node): Node | undefined {
  if (node.type === 'TaggedTemplateExpression')
    return node.tag

  return node.type === 'CallExpression' || node.type === 'OptionalCallExpression' || node.type === 'NewExpression' ? node.callee : undefined
}

function initializerEffects(node: Node, source: string, vetted: ReadonlySet<Node>, found: { line: number, type: string, code: string }[] = []) {
  if (vetted.has(node))
    return found

  // A function body and an instance field initializer run later; a static initializer and a computed key run now.
  if (FUNCTIONS.has(node.type) || (INSTANCE_FIELDS.has(node.type) && !(node as { static?: boolean }).static)) {
    const member = node as { computed?: boolean, key?: Node }

    if (member.computed === true && member.key)
      initializerEffects(member.key, source, vetted, found)

    return found
  }

  if (EXPRESSION_EFFECTS.has(node.type) || (node.type === 'UnaryExpression' && node.operator === 'delete')) {
    const pure = node.leadingComments?.some(comment => (/[@#]__PURE__/).test(comment.value))
    const callee = calleeOf(node)
    const benign = callee !== undefined && BENIGN_CALLEES.has(calleeName(callee))

    if (!pure && !benign)
      found.push({ line: node.loc?.start.line ?? 0, type: node.type, code: source.slice(node.start ?? 0, node.end ?? 0) })
  }

  for (const [key, value] of Object.entries(node) as [string, unknown][]) {
    if (key === 'loc' || key.endsWith('Comments') || typeof value !== 'object' || value === null)
      continue

    for (const child of (Array.isArray(value) ? value : [value]) as unknown[]) {
      if (isNode(child))
        initializerEffects(child, source, vetted, found)
    }
  }

  return found
}

// The variable declarators of a top-level statement, exported or not.
function declaratorsOf(statement: Node): VariableDeclarator[] {
  const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

  return declaration?.type === 'VariableDeclaration' ? declaration.declarations : []
}

// The declarators of a statement that KNOWN vets: the declared name and the start of the whole initializer both match.
function vettedDeclarators(statement: Node, source: string, known: (typeof KNOWN)[string]): Set<Node> {
  const vetted = new Set<Node>()

  for (const declarator of declaratorsOf(statement)) {
    const initializer = declarator.init ? source.slice(declarator.init.start ?? 0, declarator.init.end ?? 0) : ''
    const entry = declarator.id.type === 'Identifier' ? known.find(([name, start]) => name === (declarator.id as { name: string }).name && initializer.startsWith(start)) : undefined

    if (entry) {
      matchedKnown.add(entry)
      vetted.add(declarator)
    }
  }

  return vetted
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
      const program = parse(source, { sourceType: 'module', plugins: ['decoratorAutoAccessors'] }).program
      const known = KNOWN[relative('src/runtime', file)] ?? []

      for (const statement of program.body) {
        // A branch the production define turned off, which the bundler drops.
        if (statement.type === 'IfStatement' && statement.test.type === 'BooleanLiteral' && !statement.test.value)
          continue

        if (EFFECTS.has(statement.type)) {
          effects.push(`${relative('src/runtime', file)}:${statement.loc?.start.line ?? '?'} ${statement.type}`)
        }
        else {
          for (const effect of initializerEffects(statement, source, vettedDeclarators(statement, source, known)))
            effects.push(`${relative('src/runtime', file)}:${effect.line} ${effect.type} ${effect.code.slice(0, 60)}`)
        }
      }
    }

    const unmatched = Object.values(KNOWN).flat().filter(entry => !matchedKnown.has(entry)).map(([name]) => name)

    expect(unmatched, 'an entry of KNOWN matching no declaration is gone from its module: remove it').toEqual([])
    expect(effects, 'a module of src/runtime running a statement as it loads goes in `sideEffects` of package.json, or the bundler drops it when nothing it exports is used').toEqual([])
  })

  it('vets the declaration KNOWN names, not another call of the same shape in the module', () => {
    const code = 'const reader = Object.assign(a, b)\nexport const other = Object.assign(c, d)\nlet reader2 = Object.assign(e)'
    const known: (typeof KNOWN)[string] = [['reader', 'Object.assign(', 'test']]
    const effects = parse(code, { sourceType: 'module' }).program.body.map(statement => initializerEffects(statement, code, vettedDeclarators(statement, code, known)).length)

    expect(effects).toEqual([0, 1, 1])
  })

  it('sees a call, an assignment or an await inside an initializer, and not inside a function', () => {
    const effectsOf = (code: string) => parse(code, { sourceType: 'module', plugins: ['decoratorAutoAccessors'] }).program.body.flatMap(statement => initializerEffects(statement, code, new Set()).map(({ type }) => type))

    expect(effectsOf('const early = (globalThis[EARLY] ??= install())')).toEqual(['AssignmentExpression', 'CallExpression'])
    expect(effectsOf('export default listen()')).toEqual(['CallExpression'])
    expect(effectsOf('export const ready = await load()')).toEqual(['AwaitExpression', 'CallExpression'])
    expect(effectsOf('class A { static on = listen(); static [key()] = 1 }')).toEqual(['CallExpression', 'CallExpression'])
    expect(effectsOf('const registry = new Registry()')).toEqual(['NewExpression'])
    expect(effectsOf('let count = 0\nexport const next = count++')).toEqual(['UpdateExpression'])
    expect(effectsOf('export const gone = delete globalThis.flag')).toEqual(['UnaryExpression'])
    expect(effectsOf('class A { [key()]() {} }')).toEqual(['CallExpression'])
    expect(effectsOf('class A { [key()] = 1; static accessor on = listen(); accessor off = listen() }')).toEqual(['CallExpression', 'CallExpression'])
    expect(effectsOf('const lazy = () => listen()\nfunction f() { listen() }\nclass A { field = listen(); method() { listen() } }')).toEqual([])
    expect(effectsOf('const id = Symbol.for("a"), m = new Map(), re = String.raw`a`, p = /* @__PURE__ */ make()')).toEqual([])
  })
})
