import type { NodePath, Scope } from '@babel/traverse'
import type * as t from '@babel/types'
import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { basename, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { parse } from '@babel/parser'
import { KayError } from '../compiler/errors'
import { loadTraverse } from '../compiler/host'
import { parseKay } from '../compiler/parser'
import { walkScope } from '../compiler/rewrite'
import { readCacheEntry, writeCacheEntry } from './cache'
import { KAY_FILE } from './files'

// Globals a server has and a browser has not: reading one in a chunk the page loads throws as the chunk evaluates, before anything of it runs.
const SERVER_ONLY = new Set(['process', 'Bun'])
// Worth parsing a source for at all.
const MENTIONED = /\b(?:process|Bun)\b/
// The one read the client build replaces with a literal, so it reaches no chunk.
const DEFINED = 'NODE_ENV'
// Bun's refusal of a builtin in a browser build, which names the module importing it and not the island that reached it.
const BUILTIN_REFUSAL = /^Browser build cannot import (?:Node\.js|Bun) builtin/
const PACKAGE_PATH = /node_modules\/((?:@[^/]+\/)?[^/]+)/
// Under the build cache: each chunk's scan by a hash of its content, its server-only names or null where it did not parse.
const SCANS_FILE = 'server-only.json'
const SCANNER_PACKAGES = ['@babel/parser/package.json', '@babel/traverse/package.json']
let scannerKey: string | undefined

type Scans = Record<string, string[] | null>

export interface ServerOnlyRead {
  name: string
  // The modules of the chunk whose own source reads it, which is where the fix goes.
  modules: string[]
}

interface Input {
  bytesInOutput?: number
}

interface Output {
  inputs?: Record<string, Input>
}

// The server-only globals a built chunk reads where a browser would run it, each with the modules it came from.
// A read a `typeof` asks about first is how a module written for both sides reaches for one, so it is left alone.
export function serverOnlyReads(code: string, modules = new Map<string, string>()): ServerOnlyRead[] {
  return readersOf(serverOnlyNames(code) ?? new Set(), modules)
}

// Each name, with the modules whose own source reads it.
function readersOf(names: Set<string>, modules: Map<string, string>): ServerOnlyRead[] {
  if (names.size === 0)
    return []

  const sources = [...modules].map(([module, source]) => ({ module, names: readsIn(source, module) }))

  return [...names].sort().map(name => ({ name, modules: sources.filter(source => source.names.has(name)).map(source => source.module) }))
}

// The server-only globals a built chunk reads, or nothing at all when kay cannot parse it, which is not the same as a chunk with none.
export function serverOnlyNames(code: string): Set<string> | undefined {
  if (!MENTIONED.test(code))
    return new Set()

  const program = parsed(code, 'js')

  return program === undefined ? undefined : namesIn(program)
}

// A `.kay` file is read by its script and server fences, which hold the JavaScript of it.
function readsIn(code: string, file: string): Set<string> {
  const source = KAY_FILE.test(file) ? fences(code) : code
  const program = MENTIONED.test(source) ? parsed(source, syntaxOf(file)) : undefined

  return program === undefined ? new Set() : namesIn(program)
}

// Whether a source is worth following the browser's imports for: it names a server-only global.
export function mentionsServerOnly(source: string): boolean {
  return MENTIONED.test(source)
}

export interface LoadTimeRead {
  name: string
  // Where in the source it is read.
  start: number
}

// What a module reads of the server as it loads, which no tree-shaking drops: the server-only globals `refuseServerOnlyReads` finds.
// A `.kay` file is read by its script and module fences, the ones the browser runs.
// A read inside a function is left out: whether it runs depends on what the importer calls, which only the build's own bundle knows.
export function loadTimeReads(source: string, path: string): LoadTimeRead[] {
  const file = KAY_FILE.test(path) ? parseKay(source) : undefined
  const spans = file ? [file.script, file.module].filter(span => span !== undefined) : [{ start: 0, end: source.length }]
  const syntax = syntaxOf(path)
  const found: LoadTimeRead[] = []

  for (const { start, end } of spans) {
    const text = source.slice(start, end)

    if (!MENTIONED.test(text))
      continue

    const program = parsed(text, syntax)

    if (program === undefined)
      continue

    walkScope(program, {
      Identifier(path: NodePath<t.Identifier>) {
        const { name } = path.node

        if (!path.isReferencedIdentifier() || path.getFunctionParent() !== null || path.findParent(parent => parent.isTSType() || ((parent.isClassProperty() || parent.isClassPrivateProperty()) && !parent.node.static)) !== null)
          return

        if (SERVER_ONLY.has(name) && !path.scope.hasBinding(name, { noGlobals: true }) && !defined(path) && !guarded(path, name))
          found.push({ name, start: start + path.node.start! })
      },
    })
  }

  return found
}

function namesIn(program: t.File): Set<string> {
  const found = new Set<string>()

  // A name declared in two fences is refused by Babel's scope, and reports nothing here: the fence reports it itself.
  walkScope(program, {
    Identifier(path: NodePath<t.Identifier>) {
      const { name } = path.node

      if (!SERVER_ONLY.has(name) || !path.isReferencedIdentifier())
        return

      // A chunk carrying a polyfill of its own binds the name, and so does any local called `process`.
      if (path.scope.hasBinding(name, { noGlobals: true }) || defined(path) || guarded(path, name))
        return

      found.add(name)
    },
  })

  return found
}

const TS_MODULE = /\.[cm]?ts$/
const JS_MODULE = /\.[cm]?js$/

type Syntax = 'js' | 'ts' | 'tsx'

// A project's own module is TypeScript, and TSX but for a plain `.ts`, where `<T>x` is a cast and not an element; a plain JavaScript one, a package's say, is read as such.
function syntaxOf(file: string): Syntax {
  if (JS_MODULE.test(file))
    return 'js'

  return TS_MODULE.test(file) ? 'ts' : 'tsx'
}

const PLUGINS = { js: [], ts: ['typescript'], tsx: ['typescript', 'jsx'] } as const

function parsed(source: string, syntax: Syntax): t.File | undefined {
  try {
    // Built output is plain JavaScript, where `a < b > (c)` is a comparison rather than type arguments.
    return parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, errorRecovery: true, attachComment: false, plugins: [...PLUGINS[syntax]] })
  }
  catch {
    return undefined
  }
}

function fences(source: string): string {
  const file = parseKay(source)

  return [file.script, file.server, file.module].map(span => span ? source.slice(span.start, span.end) : '').join('\n')
}

// `process.env.NODE_ENV`, which the client build replaces with a literal: a module reading it is not one to go and fix.
function defined(path: NodePath<t.Identifier>): boolean {
  const env = path.parentPath

  if (!env?.isMemberExpression() || env.node.object !== path.node || property(env.node) !== 'env')
    return false

  const read = env.parentPath

  return read.isMemberExpression() && property(read.node) === DEFINED
}

function property(node: t.MemberExpression): string | undefined {
  if (!node.computed && node.property.type === 'Identifier')
    return node.property.name

  return node.property.type === 'StringLiteral' ? node.property.value : undefined
}

// Whether a `typeof` of the same name, or a `try` catching what the read throws, stands between the read and the code around it: the shapes a module takes to run on either side.
function guarded(path: NodePath<t.Identifier>, name: string): boolean {
  if (path.parentPath?.isUnaryExpression() && path.parentPath.node.operator === 'typeof')
    return true

  let child: NodePath = path
  let parent: NodePath | null = path.parentPath

  // Only up to the function holding the read: a guard outside it does not say this code runs.
  while (parent && !parent.isFunction() && !parent.isProgram()) {
    if (branchGuarded(parent, child, name, path.scope) || exitsEarlier(parent, child, name) || caught(parent, child))
      return true

    child = parent
    parent = parent.parentPath
  }

  return parent !== null && exitsEarlier(parent, child, name)
}

// A branch a guard chose: either side of an `if` or a `?:` asking about the name, the right of an `&&` or `||`, and the body of a loop.
function branchGuarded(parent: NodePath, child: NodePath, name: string, scope: Scope): boolean {
  if (parent.isIfStatement() || parent.isConditionalExpression())
    return (child.node === parent.node.consequent || child.node === parent.node.alternate) && asks(parent.node.test, name, scope)

  if (parent.isLogicalExpression())
    return child.node === parent.node.right && asks(parent.node.left, name, scope)

  if (parent.isWhileStatement() || parent.isDoWhileStatement() || (parent.isForStatement() && parent.node.test !== null))
    return child.node === parent.node.body && asks(parent.node.test!, name, scope)

  return false
}

// The block of a `try` with a `catch`, which takes the ReferenceError a missing global throws: `try { p = process } catch {}`. A `finally` alone lets it through.
function caught(parent: NodePath, child: NodePath): boolean {
  return parent.isTryStatement() && child.node === parent.node.block && parent.node.handler !== null
}

// `if (typeof process === 'undefined') return`, after which the block runs only where it exists.
function exitsEarlier(parent: NodePath, child: NodePath, name: string): boolean {
  const body = parent.isBlockStatement() || parent.isProgram() ? parent.node.body : undefined

  if (body === undefined)
    return false

  for (const statement of body.slice(0, body.indexOf(child.node as t.Statement))) {
    if (statement.type === 'IfStatement' && asksTypeof(statement.test, name) && exits(statement.consequent))
      return true
  }

  return false
}

function exits(node: t.Statement): boolean {
  const last = node.type === 'BlockStatement' ? node.body.at(-1) : node

  return last !== undefined && (last.type === 'ReturnStatement' || last.type === 'ThrowStatement')
}

// Whether a test asks whether the name exists, itself or through a flag it was stored in once.
function asks(test: t.Node, name: string, scope: Scope): boolean {
  if (asksTypeof(test, name))
    return true

  for (const read of references(test)) {
    const binding = scope.getBinding(read)
    const declarator = binding?.path.isVariableDeclarator() ? binding.path.node : undefined

    if (declarator?.init && asksTypeof(declarator.init, name))
      return true
  }

  return false
}

// Babel's traverse visits a node's children and not the node, which a test of one identifier is made of.
function references(node: t.Node): Set<string> {
  const names = new Set<string>()
  const add = (found: t.Node) => {
    if (found.type === 'Identifier')
      names.add(found.name)
  }

  add(node)
  loadTraverse()(node, { noScope: true, Identifier: (path: NodePath<t.Identifier>) => add(path.node) })

  return names
}

// The name the first `typeof` of the node asks about, which must be the one at hand: a guard on another global says nothing about this one.
function asksTypeof(node: t.Node, name: string): boolean {
  let askedOf: string | undefined
  const ask = (found: t.Node) => {
    if (found.type === 'UnaryExpression' && found.operator === 'typeof' && found.argument.type === 'Identifier')
      askedOf ??= found.argument.name
  }

  ask(node)
  loadTraverse()(node, { noScope: true, UnaryExpression: (path: NodePath<t.UnaryExpression>) => ask(path.node) })

  return askedOf === name
}

// Refuses a client build whose chunks read a server-only global: such a chunk throws as the browser evaluates it, so every island in it stays dead.
// `dir` is where the bundler wrote them, the metafile naming each chunk relative to it and each module relative to where the build ran.
// With `cacheDir`, a chunk scanned by the build before, its content unchanged, is not parsed again.
export async function refuseServerOnlyReads(root: string, dir: string, outputs: Record<string, Output>, cacheDir?: string): Promise<void> {
  const problems: string[] = []
  const slot = cacheDir === undefined ? undefined : { file: join(cacheDir, SCANS_FILE), key: scanKey() }
  const cached = (slot && await readCacheEntry<Scans>(slot)) ?? {}
  const scans: Scans = {}
  // Only the modules whose code is in a chunk: a tree-shaken one is listed with none of it.
  const modulesOf = async (meta: Output) => new Map((await Promise.all(Object.entries(meta.inputs ?? {}).filter(([, input]) => (input.bytesInOutput ?? 0) > 0).map(async ([input]) => {
    const path = resolve(process.cwd(), input)
    const source = await sourceOf(path)

    return source === undefined ? undefined : [path.startsWith(root + sep) ? relative(root, path) : input, source] as const
  }))).filter(entry => entry !== undefined))

  await Promise.all(Object.entries(outputs).map(async ([file, meta]) => {
    if (!file.endsWith('.js'))
      return

    const code = await sourceOf(resolve(dir, file))
    // Unchecked rather than silently fine: the read this looks for is one only the browser's console would report.
    const unchecked = (why: string) => void console.warn(`kay: ${basename(file)} ${why}, so it was not checked for a \`process\` or \`Bun\` read the browser would throw on`)

    if (code === undefined)
      return unchecked('could not be read')

    const names = scanned(code, cached, scans)

    if (names === undefined)
      return unchecked('could not be parsed')

    if (names.size === 0)
      return

    for (const { name, modules } of readersOf(names, await modulesOf(meta)))
      problems.push(`\`${name}\` in ${basename(file)}, read by ${modules.length > 0 ? modules.join(', ') : 'a module of it kay could not pin down'}`)
  }))

  if (slot)
    await writeCacheEntry(slot, scans)

  if (problems.length > 0)
    throw new KayError('server-only-in-island', `kay: a browser has no \`process\` or \`Bun\`, and these chunks a page loads read one, so every island in them dies as the chunk evaluates: ${problems.sort().join('; ')}. Keep the module reading it out of what an island imports, directly or through the page's script fence, and pass what it holds as a prop; ask \`typeof\` first where the module runs on both sides.`)
}

function knownNames(known: string[] | null): Set<string> | undefined {
  return known === null ? undefined : new Set(known)
}

// A chunk's server-only names, taken from the last build's scans when they hold its content, and recorded in this build's.
function scanned(code: string, cached: Scans, scans: Scans): Set<string> | undefined {
  if (!MENTIONED.test(code))
    return new Set()

  const hash = Bun.hash(code).toString(36)
  const known = cached[hash]
  const names = known === undefined ? serverOnlyNames(code) : knownNames(known)

  scans[hash] = names === undefined ? null : [...names]

  return names
}

// What a scan depends on besides the chunk: this module, and the parser and traverse it runs through.
function scanKey(): string {
  scannerKey ??= Bun.hash([import.meta.path, ...SCANNER_PACKAGES.map(manifest => Bun.resolveSync(manifest, import.meta.dir))].map(file => readFileSync(file, 'utf8')).join('\0')).toString(36)

  return scannerKey
}

// A module of the chunk kay cannot read, a virtual one for instance, tells nothing about where the read came from.
async function sourceOf(file: string): Promise<string | undefined> {
  try {
    return await Bun.file(file).text()
  }
  catch {
    return undefined
  }
}

interface InputImport {
  path: string
  external?: boolean
}

export type BundleInputs = Record<string, { imports: InputImport[] }>

// The builtins Bun refused a browser build for.
export function refusedBuiltins(logs: readonly (BuildMessage | ResolveMessage)[]): string[] {
  return [...new Set(logs.flatMap(log => log.name === 'ResolveMessage' && BUILTIN_REFUSAL.test(log.message) ? [log.specifier] : []))]
}

// The shortest chain of imports from `start` to one of the refused builtins, as the keys of `inputs` ending on the builtin, and as the build prints it: cut at the first package, since the fix is never inside one.
export function builtinChain(root: string, inputs: BundleInputs, start: string, refused: { has: (name: string) => boolean }): { path: string[], text: string } | undefined {
  const parents = new Map<string, string | undefined>([[start, undefined]])
  const queue = [start]
  let reached: { input: string, builtin: string } | undefined

  while (queue.length > 0 && !reached) {
    const input = queue.shift()!

    for (const { path, external } of inputs[input]?.imports ?? []) {
      if (external && refused.has(path)) {
        reached = { input, builtin: path }

        break
      }

      if (!external && !parents.has(path)) {
        parents.set(path, input)
        queue.push(path)
      }
    }
  }

  if (!reached)
    return undefined

  const path: string[] = [reached.builtin]

  for (let input: string | undefined = reached.input; input !== undefined; input = parents.get(input))
    path.unshift(input)

  const shown: string[] = []

  for (const input of path.slice(0, -1)) {
    const file = relative(root, resolve(process.cwd(), input))
    const name = PACKAGE_PATH.exec(file)?.[1]

    shown.push(name ?? file)

    if (name !== undefined)
      break
  }

  return { path, text: [...shown, reached.builtin].join(' -> ') }
}

// For each island reaching one of the builtins, the chain from it.
// `inputs` is the metafile of the same build with the builtins left external, its modules named relative to where the build ran.
export function builtinChains(root: string, inputs: BundleInputs, islands: Iterable<string>, builtins: string[]): string[] {
  const refused = new Set(builtins)
  const keyOf = new Map(Object.keys(inputs).map(input => [resolve(process.cwd(), input), input]))
  const chains: string[] = []

  for (const island of islands) {
    const start = keyOf.get(island)
    const chain = start === undefined ? undefined : builtinChain(root, inputs, start, refused)

    if (chain)
      chains.push(chain.text)
  }

  return chains
}

// Every builtin, the ones Bun polyfills included: one whose polyfill lacks an export would fail the build that only looks for the way to the others.
export const BUILTINS = [...builtinModules, 'node:*', 'bun', 'bun:*']
const BUILTIN_NAMES = new Set(BUILTINS)
let browserRefusals: Promise<(specifier: string) => boolean> | undefined

// Whether a browser build refuses an import: only the builtins Bun does not polyfill, `async_hooks` and `bun:*` among them, so `node:path` and `events` build.
// Asked of one build of every builtin, once per process, so it follows the Bun running.
export async function browserRefuses(): Promise<(specifier: string) => boolean> {
  browserRefusals ??= (async () => {
    const names = [...builtinModules, ...builtinModules.map(name => `node:${name}`), 'bun']
    const probe = await Bun.build({ entrypoints: ['probe.js'], files: { 'probe.js': names.map(name => `import ${JSON.stringify(name)}`).join('\n') }, target: 'browser', throw: false })
    const refused = new Set(refusedBuiltins(probe.logs))

    return (specifier: string) => specifier === 'bun' || specifier.startsWith('bun:') || refused.has(specifier)
  })()

  return browserRefusals
}

// Whether an import names a module a browser lacks: a Node builtin, with or without its `node:` prefix, or Bun's.
export function isBuiltinSpecifier(specifier: string): boolean {
  return BUILTIN_NAMES.has(specifier) || specifier.startsWith('node:') || specifier.startsWith('bun:')
}

// Bun names the module importing a builtin a browser lacks, not the island reaching it: the same build with every builtin left out, in memory, gives the imports leading there.
// An island bundles all of a module it imports, whatever it opens as it loads included, so the fix is in that chain.
export async function refuseBuiltinImports(root: string, logs: readonly (BuildMessage | ResolveMessage)[], islands: Iterable<string>, config: Bun.BuildConfig): Promise<void> {
  const builtins = refusedBuiltins(logs)

  if (builtins.length === 0)
    return

  const probe = await Bun.build({ ...config, external: [...config.external ?? [], ...BUILTINS], throw: false })
  const chains = probe.success ? builtinChains(root, probe.metafile!.inputs, islands, builtins) : []

  if (chains.length > 0)
    throw new KayError('browser-builtin-import', `kay: an island cannot import a server module, and a browser has no ${builtins.join(', ')}: ${chains.join('; ')}. An island bundles every module it imports, the database or environment one opens as it loads included: move what the island needs, a constant or a type, to a module importing no server code, or pass it as a prop.`)
}
