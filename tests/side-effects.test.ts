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
// The declarations whose initializer calls something as the module loads and is fine to drop with it: the declared name, the labels of those calls from the outermost in (see `callLabel`), and why dropping it changes nothing.
// Only those calls are vetted, so a call added to their arguments, or one more in the chain, is reported.
const KNOWN: Record<string, [name: string, calls: string[], why: string][]> = {
  'await.server.ts': [['early', ['??=', 'installEarlyRejections'], 'the listener only matters to a page that awaits, which keeps the module']],
  'cache.server.ts': [['PROCESS', ['crypto.randomUUID'], 'an id for this process, read by the module\'s own functions']],
  'consent.ts': [
    ['reader', ['Object.assign'], 'adds the setters to the reader the module exports'],
    ['consent', ['markSignal'], 'adds the reader to the set of signals, which matters only once the export is read'],
  ],
  'live.ts': [['call', ['Object.assign'], 'adds `track` to the function the module exports']],
  'markdown.client.ts': [['marked', ['Marked'], 'builds the renderer the module\'s functions use']],
  'page-swap.ts': [['served', ['servedRoot'], 'reads the page\'s own markup into a map the module\'s functions use']],
  'work.ts': [
    ['PRIMES', ['.filter', 'Array.from'], 'constants worked out from other constants'],
    ['ROUNDS', ['Uint32Array.from'], 'constants worked out from other constants'],
    ['FIRST_PRIMES', ['PRIMES.slice'], 'constants worked out from other constants'],
    ['START', ['Uint32Array.from'], 'constants worked out from other constants'],
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
const matchedKnown = new Set<unknown>()

const isPure = (node: Node) => node.leadingComments?.some(comment => (/[@#]__PURE__/).test(comment.value)) === true

function calleeOf(node: Node): Node | undefined {
  if (node.type === 'TaggedTemplateExpression')
    return node.tag

  return node.type === 'CallExpression' || node.type === 'OptionalCallExpression' || node.type === 'NewExpression' ? node.callee : undefined
}

function initializerEffects(node: Node, source: string, vetted: ReadonlySet<Node>, found: { line: number, type: string, code: string }[] = []) {
  // A function body and an instance field initializer run later; a static initializer and a computed key run now.
  if (FUNCTIONS.has(node.type) || (INSTANCE_FIELDS.has(node.type) && !(node as { static?: boolean }).static)) {
    const member = node as { computed?: boolean, key?: Node }

    if (member.computed === true && member.key)
      initializerEffects(member.key, source, vetted, found)

    return found
  }

  if (!vetted.has(node) && (EXPRESSION_EFFECTS.has(node.type) || (node.type === 'UnaryExpression' && node.operator === 'delete'))) {
    const pure = isPure(node)
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

// The label of a call, a `new` or an assignment: the callee as written when it is a name or a dotted name, `.name` for a method of another call's result, the operator for an assignment.
function callLabel(node: Node): string {
  if (node.type === 'AssignmentExpression')
    return node.operator

  const callee = calleeOf(node)

  if (callee?.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier')
    return callee.object.type === 'Identifier' ? calleeName(callee) : `.${callee.property.name}`

  return callee ? calleeName(callee) : '?'
}

// The calls and assignments an initializer makes whatever its arguments hold, outermost first: through a condition's branches, an operator's sides, an assignment's value, and a call's callee chain.
function outerCalls(node: Node | null | undefined): Node[] {
  if (!node)
    return []

  if (node.type === 'ConditionalExpression')
    return [...outerCalls(node.consequent), ...outerCalls(node.alternate)]

  if (node.type === 'LogicalExpression')
    return [...outerCalls(node.left), ...outerCalls(node.right)]

  if (node.type === 'AssignmentExpression')
    return [node, ...outerCalls(node.right)]

  if (node.type === 'MemberExpression')
    return outerCalls(node.object)

  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression' || node.type === 'NewExpression')
    return [...(isPure(node) || BENIGN_CALLEES.has(calleeName(node.callee)) ? [] : [node]), ...outerCalls(node.callee)]

  return []
}

// The nodes that KNOWN vets in a statement: the outer calls of a declarator when its name and their labels both match, never what is inside their arguments.
function vettedCalls(statement: Node, known: (typeof KNOWN)[string]): Set<Node> {
  const vetted = new Set<Node>()

  for (const declarator of declaratorsOf(statement)) {
    const calls = outerCalls(declarator.init)
    const labels = calls.map(callLabel)
    const entry = declarator.id.type === 'Identifier' ? known.find(([name, expected]) => name === (declarator.id as { name: string }).name && expected.join() === labels.join()) : undefined

    if (entry) {
      matchedKnown.add(entry)

      for (const call of calls)
        vetted.add(call)
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
          for (const effect of initializerEffects(statement, source, vettedCalls(statement, known)))
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
    const known: (typeof KNOWN)[string] = [['reader', ['Object.assign'], 'test']]
    const effects = parse(code, { sourceType: 'module' }).program.body.map(statement => initializerEffects(statement, code, vettedCalls(statement, known)).length)

    expect(effects).toEqual([0, 1, 1])
  })

  it('vets only the outer call of a declaration, so a call added to its arguments or its chain is reported', () => {
    const effectsOf = (code: string, calls: string[]) => parse(code, { sourceType: 'module' }).program.body.map(statement => initializerEffects(statement, code, vettedCalls(statement, [['reader', calls, 'test']])).length)

    expect(effectsOf('const reader = Object.assign(() => 1, { set: () => listen() })', ['Object.assign'])).toEqual([0])
    expect(effectsOf('const reader = Object.assign(() => 1, { set: listen() })', ['Object.assign'])).toEqual([1])
    expect(effectsOf('const reader = Object.assign(listen(), {})', ['Object.assign'])).toEqual([1])
    expect(effectsOf('const reader = Object.assign(a, b).extra()', ['Object.assign'])).toEqual([2])
    expect(effectsOf('const reader = Array.from(a).filter(b)', ['.filter', 'Array.from'])).toEqual([0])
    expect(effectsOf('const reader = Array.from(a).filter(listen())', ['.filter', 'Array.from'])).toEqual([1])
  })

  it('matches a vetted call by its callee wherever the output text puts it', () => {
    const effectsOf = (code: string) => parse(code, { sourceType: 'module' }).program.body.map(statement => initializerEffects(statement, code, vettedCalls(statement, [['served', ['servedRoot'], 'test']])).length)

    expect(effectsOf('let served = typeof document === "undefined" ? new Map : servedRoot(document)')).toEqual([0])
    expect(effectsOf('let served = typeof document === \'undefined\' ? new Map() : (servedRoot(document))')).toEqual([0])
    expect(effectsOf('let served = typeof document === "undefined" ? new Map : servedRoot(document, listen())')).toEqual([1])
    expect(effectsOf('let served = typeof document === "undefined" ? new Map : other(document)')).toEqual([1])
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
