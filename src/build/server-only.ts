import type { NodePath, Scope } from '@babel/traverse'
import type * as t from '@babel/types'
import { basename, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { parse } from '@babel/parser'
import { parseKay } from '../compiler/parser'
import { loadTraverse } from '../compiler/rewrite'

// Globals a server has and a browser has not: reading one in a chunk the page loads throws as the chunk evaluates, before anything of it runs.
const SERVER_ONLY = new Set(['process', 'Bun'])
// Worth parsing a source for at all.
const MENTIONED = /\b(?:process|Bun)\b/
const KAY_FILE = /\.kay$/
// The one read the client build replaces with a literal, so it reaches no chunk.
const DEFINED = 'NODE_ENV'
// Part of the message of the browser's stand-in for kay's `t`, which survives minifying: a chunk holding it builds a schema where Elysia is not.
const BROWSER_T = 'builds a schema on the server, and kay'
const KAY_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]kay['"]/g
const T_SPECIFIER = /^t(?:\s+as\s+\w+)?$/

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
  const names: Set<string> = serverOnlyNames(code) ?? new Set()

  if (names.size === 0)
    return []

  const sources = [...modules].map(([module, source]) => ({ module, names: readsIn(source, KAY_FILE.test(module)) }))

  return [...names].sort().map(name => ({ name, modules: sources.filter(source => source.names.has(name)).map(source => source.module) }))
}

// The server-only globals a built chunk reads, or nothing at all when kay cannot parse it, which is not the same as a chunk with none.
export function serverOnlyNames(code: string): Set<string> | undefined {
  if (!MENTIONED.test(code))
    return new Set()

  return parsed(code, false) === undefined ? undefined : readsIn(code, false)
}

// `fenced` reads a `.kay` file, whose script and server fences hold the JavaScript of it.
function readsIn(code: string, fenced: boolean): Set<string> {
  const found = new Set<string>()
  const source = fenced ? fences(code) : code

  if (!MENTIONED.test(source))
    return found

  const program = parsed(source, fenced)

  if (program === undefined)
    return found

  loadTraverse()(program, {
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

function parsed(source: string, fenced: boolean): t.File | undefined {
  try {
    // Built output is plain JavaScript, where `a < b > (c)` is a comparison rather than type arguments.
    return parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, errorRecovery: true, plugins: fenced ? ['typescript', 'jsx'] : [] })
  }
  catch {
    return undefined
  }
}

function fences(source: string): string {
  const file = parseKay(source)

  return [file.script, file.server].map(span => span ? source.slice(span.start, span.end) : '').join('\n')
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

// Whether a `typeof` of the same name stands between the read and the code around it: the shape a module takes to run on either side.
function guarded(path: NodePath<t.Identifier>, name: string): boolean {
  if (path.parentPath?.isUnaryExpression() && path.parentPath.node.operator === 'typeof')
    return true

  let child: NodePath = path
  let parent: NodePath | null = path.parentPath

  // Only up to the function holding the read: a guard outside it does not say this code runs.
  while (parent && !parent.isFunction() && !parent.isProgram()) {
    if (branchGuarded(parent, child, name, path.scope) || exitsEarlier(parent, child, name))
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
export async function refuseServerOnlyReads(root: string, dir: string, outputs: Record<string, Output>): Promise<void> {
  const problems: string[] = []
  const schemaBuilders = new Set<string>()

  await Promise.all(Object.entries(outputs).map(async ([file, meta]) => {
    if (!file.endsWith('.js'))
      return

    const code = await sourceOf(resolve(dir, file))
    // Unchecked rather than silently fine: the read this looks for is one only the browser's console would report.
    const unchecked = (why: string) => void console.warn(`kay: ${basename(file)} ${why}, so it was not checked for a \`process\` or \`Bun\` read the browser would throw on`)

    if (code === undefined)
      return unchecked('could not be read')

    const names = serverOnlyNames(code)

    if (names === undefined)
      return unchecked('could not be parsed')

    const buildsSchemas = code.includes(BROWSER_T)

    if (names.size === 0 && !buildsSchemas)
      return

    // Only the modules whose code is in the chunk: a tree-shaken one is listed with none of it.
    const kept = Object.entries(meta.inputs ?? {}).filter(([, input]) => (input.bytesInOutput ?? 0) > 0).map(([input]) => input)
    const sources = new Map((await Promise.all(kept.map(async (input) => {
      const path = resolve(process.cwd(), input)
      const source = await sourceOf(path)

      return source === undefined ? undefined : [path.startsWith(root + sep) ? relative(root, path) : input, source] as const
    }))).filter(entry => entry !== undefined))

    if (buildsSchemas) {
      const builders = [...sources].filter(([module, source]) => importsKayT(KAY_FILE.test(module) ? scriptFence(source) : source)).map(([module]) => module)

      for (const module of builders.length > 0 ? builders : [`a module of ${basename(file)} kay could not pin down`])
        schemaBuilders.add(module)
    }

    for (const { name, modules } of serverOnlyReads(code, sources))
      problems.push(`\`${name}\` in ${basename(file)}, read by ${modules.length > 0 ? modules.join(', ') : 'a module of it kay could not pin down'}`)
  }))

  const refusals: string[] = []

  if (problems.length > 0)
    refusals.push(`a browser has no \`process\` or \`Bun\`, and these chunks a page loads read one, so every island in them dies as the chunk evaluates: ${problems.sort().join('; ')}. Keep the module reading it out of what an island imports, directly or through the page's script fence, and pass what it holds as a prop; ask \`typeof\` first where the module runs on both sides.`)

  if (schemaBuilders.size > 0)
    refusals.push(`kay's \`t\` builds schemas on the server only, and an island imports ${[...schemaBuilders].sort().join(', ')}, which take${schemaBuilders.size === 1 ? 's' : ''} it from 'kay': its first \`t.Object(...)\` would throw as the island loads, and Elysia's own \`t\` reads \`Bun\`. Keep the schemas in a module only the server imports, and what an island needs of them, a length or a list of choices, in another.`)

  if (refusals.length > 0)
    throw new Error(`kay: ${refusals.join(' And ')}`)
}

// Whether a module imports `t` itself from 'kay', not as a type.
function importsKayT(source: string): boolean {
  for (const [, specifiers] of source.matchAll(KAY_IMPORT)) {
    if (specifiers!.split(',').some(specifier => T_SPECIFIER.test(specifier.trim())))
      return true
  }

  return false
}

// The component script of a `.kay` file: its server fence never reaches the browser.
function scriptFence(source: string): string {
  const { script } = parseKay(source)

  return script ? source.slice(script.start, script.end) : ''
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
