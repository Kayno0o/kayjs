import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic, Fix, KayFile, Node, Span } from './ast'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { parse } from '@babel/parser'
import { awaitBlocks, tryBlocks } from './ast'
import { loadTraverse } from './rewrite'

// One part of the program `browserReads` analyzes: generated text standing for the source from `source` on, character for character.
interface Segment {
  generated: number
  source: number
  length: number
}

interface Read {
  name: string
  at: number
  // The functions around the read, innermost first.
  chain: t.Node[]
  typeOf: boolean
  // The fence's top-level statement holding it, when it sits there outside any function.
  statement?: t.Statement
}

const DECLARED_GLOBAL = /^declare (?:var|function) ([\w$]+)/gm
const WORD = /[a-z_$][\w$]*/gi
const EVENT_HANDLER = /^on[A-Z]/
// A function passed to one of these runs before the call returns, so as the render runs.
const RENDER_CALLS = new Set(['memo', 'untrack', 'batch'])
const ARRAY_CALLBACKS = new Set(['map', 'flatMap', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'reduce', 'reduceRight', 'forEach', 'sort', 'toSorted'])
// TypeScript nodes wrapping a value rather than spelling a type.
const TS_EXPRESSIONS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression'])
const FENCE_OPENING = '---'
const NOT_DEFINED = /^(\S+) is not defined$/
const TYPEOF_GLOBAL = /\btypeof\s+([a-z_$][\w$]*)/gi
// What may render differently on the server and in the browser, worth a scope analysis in an island.
const VARYING_HINT = /\b(?:Date|Math|toLocale\w*|Intl)\b/
const LOCALE_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'])
const MOVED = 'read it in `effect` or `onMount`, or on the server and pass it as a prop'
const BROWSER_ONLY_HELP = 'read it in `effect` or `onMount`, or render the component in the browser only with `--- client`'
const MISMATCH = 'what the island renders from it will not match the server\'s markup when it hydrates'
const CLOCK = { reason: 'reads the clock, which has moved on by the time the island hydrates', remedy: MOVED }
const RANDOM = { reason: 'gives another number in the browser', remedy: MOVED }
const NO_LOCALE = { reason: 'formats in the server\'s default locale there and in the visitor\'s in the browser', remedy: 'pass it a locale' }
const NO_TIME_ZONE = { reason: 'formats in the server\'s time zone there and in the visitor\'s in the browser', remedy: 'pass it a `timeZone`' }

// A value an island computes as it renders that the server and the browser compute apart.
interface Varying {
  label: string
  reason: string
  remedy: string
  start: number
  end: number
  chain: t.Node[]
}

let globals: Set<string> | undefined

// What lib.dom declares as globals and Bun's own globalThis lacks: reading one on the server throws.
// Bun's globals come from a process of its own, as a test registering a DOM, or a preload, would add some to this one.
export function browserGlobals(): ReadonlySet<string> {
  if (globals)
    return globals

  globals = new Set()

  try {
    const preview = dirname(Bun.resolveSync('@typescript/native-preview/package.json', import.meta.dir))
    const platform = dirname(Bun.resolveSync(`@typescript/native-preview-${process.platform}-${process.arch}/package.json`, preview))
    const lib = readFileSync(join(platform, 'lib', 'lib.dom.d.ts'), 'utf8')
    const own = Bun.spawnSync([process.execPath, '-e', 'console.log(JSON.stringify(Object.getOwnPropertyNames(globalThis)))'], { cwd: tmpdir() })
    const bun = new Set(JSON.parse(own.stdout.toString()) as string[])

    for (const match of lib.matchAll(DECLARED_GLOBAL)) {
      if (!bun.has(match[1]!))
        globals.add(match[1]!)
    }
  }
  catch {}

  return globals
}

// The browser-only global an error says is not defined, as Bun words a read of it on the server.
export function browserGlobalMissing(error: unknown): string | undefined {
  const { name, message } = (error ?? {}) as { name?: unknown, message?: unknown }
  const missing = name === 'ReferenceError' && typeof message === 'string' ? NOT_DEFINED.exec(message)?.[1] : undefined

  return missing !== undefined && browserGlobals().has(missing) ? missing : undefined
}

// Browser-only globals the component reads while it renders, which throws on the server, and `typeof` checks of them, which render differently there and break hydration.
// Rendering covers the script's top level, the template's values, `memo` and array callbacks, and the script's functions those call; handlers, refs, effects and other callbacks run in the browser only.
// `serverNames` are what the `--- server` fence hands the template; a route file renders on the server, so it is offered no `--- client`.
export function browserReads(file: KayFile, island: boolean, serverNames: string[], routeFile: boolean): Diagnostic[] {
  const names = browserGlobals()
  const { source } = file
  const expressions = templateExpressions(file)
  const texts = [file.script ? source.slice(file.script.start, file.script.end) : '', ...expressions.map(expression => source.slice(expression.span.start, expression.span.end))]

  if (!texts.some(text => Array.from(text.matchAll(WORD)).some(match => names.has(match[0])) || (island && VARYING_HINT.test(text))))
    return []

  const program = buildProgram(file, serverNames, expressions)
  let ast: t.File

  try {
    ast = parse(program.code, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
  }
  catch {
    return []
  }

  const toSource = (generated: number): number | undefined => {
    const segment = program.segments.find(candidate => generated >= candidate.generated && generated <= candidate.generated + candidate.length)

    return segment && segment.source + generated - segment.generated
  }
  const transparent = new Set<t.Node>()
  const functions = new Map<string, t.Node>()
  const calls: { name: string, chain: t.Node[] }[] = []
  const reads: Read[] = []
  const varying: Varying[] = []
  let effectBound = false

  const noteVarying = (path: NodePath<t.CallExpression | t.NewExpression>) => {
    const found = island ? varyingValue(path) : undefined

    if (found)
      varying.push({ ...found, start: path.node.start!, end: path.node.end!, chain: functionChain(path) })
  }

  // A name the template binds twice over the script's, which no block can tell apart, leaves nothing to report rather than failing the check.
  try {
    loadTraverse()(ast, {
      Function(path) {
        const parent = path.parentPath

        if (parent.isCallExpression() && (parent.node.callee === path.node || rendersCallback(parent.node, path.node)))
          transparent.add(path.node)

        if (path.isFunctionDeclaration() && parent.isProgram() && path.node.id)
          functions.set(path.node.id.name, path.node)
        else if (parent.isVariableDeclarator() && parent.node.id.type === 'Identifier' && parent.parentPath.parentPath?.isProgram())
          functions.set(parent.node.id.name, path.node)
      },
      CallExpression(path) {
        const callee = path.node.callee

        if (callee.type === 'Identifier' && path.scope.getBinding(callee.name)?.scope.path.isProgram())
          calls.push({ name: callee.name, chain: functionChain(path) })

        noteVarying(path)
      },
      NewExpression(path) {
        noteVarying(path)
      },
      Program(path) {
        effectBound = path.scope.hasBinding('effect', true)
      },
      Identifier(path) {
        const { name } = path.node

        if (!names.has(name) || !path.isReferencedIdentifier() || path.scope.hasBinding(name, true) || inType(path))
          return

        const typeOf = path.parentPath.isUnaryExpression({ operator: 'typeof' })

        if (!typeOf && guarded(path, program.code, names))
          return

        const chain = functionChain(path)
        const statement = chain.length === 0 ? path.findParent(ancestor => ancestor.parentPath?.isProgram() === true)?.node as t.Statement | undefined : undefined

        reads.push({ name, at: path.node.start!, chain, typeOf, statement })
      },
    })
  }
  catch {
    return []
  }

  const rendering = new Set(transparent)
  const renders = (chain: t.Node[]) => chain.every(fn => rendering.has(fn))
  let grew = true

  while (grew) {
    grew = false

    for (const call of calls) {
      const fn = functions.get(call.name)

      if (fn && !rendering.has(fn) && renders(call.chain)) {
        rendering.add(fn)
        grew = true
      }
    }
  }

  const diagnostics: Diagnostic[] = []
  const toClient = routeFile ? [] : clientFix(file)

  for (const read of reads) {
    const start = toSource(read.at)

    if (start === undefined || !renders(read.chain))
      continue

    const span = { start, end: start + read.name.length }

    if (!read.typeOf)
      diagnostics.push({ ...span, message: `\`${read.name}\` exists only in the browser`, note: 'this reads it while the component renders on the server too', help: BROWSER_ONLY_HELP, fixes: [...effectFix(file, program.code, read, effectBound, toSource, ast), ...toClient], checkOnly: true })
    else if (island)
      diagnostics.push({ ...span, message: `\`typeof ${read.name}\` differs between the server and the browser`, note: MISMATCH, help: BROWSER_ONLY_HELP, fixes: toClient, checkOnly: true })
  }

  for (const value of varying) {
    const start = toSource(value.start)
    const end = toSource(value.end)

    if (start !== undefined && end !== undefined && renders(value.chain))
      diagnostics.push({ start, end, message: `\`${value.label}\` ${value.reason}`, note: MISMATCH, help: value.remedy, checkOnly: true })
  }

  return diagnostics
}

// The clock, a random number, or a locale or time zone left to the platform, as a call or a `new` gives them; options the code computes are taken as setting them.
function varyingValue(path: NodePath<t.CallExpression | t.NewExpression>): Omit<Varying, 'start' | 'end' | 'chain'> | undefined {
  const { callee, arguments: args } = path.node
  const global = (node: t.Node, name: string) => node.type === 'Identifier' && node.name === name && !path.scope.hasBinding(name, true)
  const noLocale = (locale: t.Node | undefined) => locale === undefined || global(locale, 'undefined')

  if (global(callee, 'Date'))
    return args.length === 0 ? { label: path.isNewExpression() ? 'new Date()' : 'Date()', ...CLOCK } : undefined

  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier')
    return undefined

  const name = callee.property.name

  if (global(callee.object, 'Date') && name === 'now')
    return { label: 'Date.now()', ...CLOCK }

  if (global(callee.object, 'Math') && name === 'random')
    return { label: 'Math.random()', ...RANDOM }

  if (global(callee.object, 'Intl')) {
    if (noLocale(args[0]))
      return { label: `Intl.${name}`, ...NO_LOCALE }

    return name === 'DateTimeFormat' && lacksOption(args[1], 'timeZone') ? { label: 'Intl.DateTimeFormat', ...NO_TIME_ZONE } : undefined
  }

  if (!path.isCallExpression() || !LOCALE_METHODS.has(name))
    return undefined

  if (noLocale(args[0]))
    return { label: `${name}()`, ...NO_LOCALE }

  // A number's `toLocaleString` has no time zone to take; only the date methods are sure to format one.
  return name !== 'toLocaleString' && lacksOption(args[1], 'timeZone') ? { label: `${name}()`, ...NO_TIME_ZONE } : undefined
}

// Options written out without the key; computed ones are taken as setting it.
function lacksOption(options: t.Node | undefined, key: string): boolean {
  return options === undefined || (options.type === 'ObjectExpression' && options.properties.every(property => property.type === 'ObjectProperty' && !property.computed && !(property.key.type === 'Identifier' && property.key.name === key) && !(property.key.type === 'StringLiteral' && property.key.value === key)))
}

// `memo(() => ...)` and `rows.map(row => ...)` run the function they take before they return.
function rendersCallback(call: t.CallExpression, fn: t.Node): boolean {
  if (call.arguments[0] !== fn)
    return false

  const callee = call.callee

  if (callee.type === 'Identifier')
    return RENDER_CALLS.has(callee.name)

  return callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && ARRAY_CALLBACKS.has(callee.property.name)
}

// A read the code already keeps from running on the server: under a `typeof` check of a browser-only global, or inside a `try`.
function guarded(path: NodePath, code: string, names: ReadonlySet<string>): boolean {
  const at = path.node.start!
  const checks = (test: t.Node) => Array.from(code.slice(test.start!, test.end!).matchAll(TYPEOF_GLOBAL), match => match[1]!).some(name => names.has(name))

  return path.findParent((ancestor) => {
    const node = ancestor.node

    if (node.type === 'TryStatement')
      return at >= node.block.start! && at < node.block.end!

    if (node.type === 'IfStatement' || node.type === 'ConditionalExpression')
      return (at < node.test.start! || at >= node.test.end!) && checks(node.test)

    return node.type === 'LogicalExpression' && at >= node.right.start! && checks(node.left)
  }) !== null
}

function functionChain(path: NodePath): t.Node[] {
  const chain: t.Node[] = []

  for (let fn = path.getFunctionParent(); fn; fn = fn.parentPath.getFunctionParent())
    chain.push(fn.node)

  return chain
}

function inType(path: NodePath): boolean {
  return path.findParent(ancestor => ancestor.node.type.startsWith('TS') && !TS_EXPRESSIONS.has(ancestor.node.type)) !== null
}

// The script, then each template value as a statement of its own, so one scope analysis sees them all: a handler or ref sits in a function, which runs in the browser only.
// Names the server fence and the template bind are declared first, so they shadow the globals they are named after.
function buildProgram(file: KayFile, serverNames: string[], expressions: { span: Span, deferred: boolean }[]): { code: string, segments: Segment[] } {
  const { source } = file
  const bound = [...new Set([...serverNames, ...templateNames(file)])]
  // Each template value sits in a block of its own declaring them, so they shadow the script's names rather than clash with them.
  const declared = bound.length > 0 ? `let ${bound.join(', ')}; ` : ''
  let code = ''
  const segments: Segment[] = []
  const add = (span: Span, before: string, after: string) => {
    code += before
    segments.push({ generated: code.length, source: span.start, length: span.end - span.start })
    code += `${source.slice(span.start, span.end)}${after}`
  }

  if (file.script)
    add(file.script, '', '\n')

  for (const expression of expressions)
    add(expression.span, expression.deferred ? `;() => { ${declared}(` : `;{ ${declared}(`, ') }\n')

  return { code, segments }
}

// The names `for`, `if ... as`, `then`, `catch` and `@slot(...)` bind for the template below them.
function templateNames(file: KayFile): string[] {
  const names: string[] = []
  const words = (span: Span | undefined) => span ? Array.from(file.source.slice(span.start, span.end).matchAll(WORD), match => match[0]) : []

  visit(file.template, (node) => {
    if (node.kind === 'for') {
      names.push(...words(node.item), ...words(node.index))
    }
    else if (node.kind === 'if') {
      for (const branch of node.branches) {
        names.push(...words(branch.alias))
      }
    }
    else if (node.kind === 'await' || node.kind === 'try') {
      names.push(...words(node.kind === 'await' ? node.resolved?.alias : undefined), ...words(node.rejected?.alias))
    }
    else if (node.kind === 'slot') {
      names.push(...words(node.params))
    }
  })

  return names
}

// Every value the template computes, deferred when it is a handler or a ref, which the browser calls later.
function templateExpressions(file: KayFile): { span: Span, deferred: boolean }[] {
  const found: { span: Span, deferred: boolean }[] = []

  visit(file.template, (node) => {
    if (node.kind === 'element') {
      for (const attribute of node.attributes) {
        if (attribute.kind === 'spread') {
          found.push({ span: attribute.expression, deferred: false })
        }
        else if (attribute.kind === 'expression') {
          const name = file.source.slice(attribute.name.start, attribute.name.end)

          found.push({ span: attribute.expression, deferred: EVENT_HANDLER.test(name) || name === 'ref' })
        }
      }
    }
    else if (node.kind === 'text') {
      for (const part of node.parts) {
        if (part.kind === 'expression')
          found.push({ span: part.expression, deferred: false })
      }
    }
    else if (node.kind === 'if') {
      for (const branch of node.branches) {
        if (branch.test)
          found.push({ span: branch.test, deferred: false })
      }
    }
    else if (node.kind === 'for') {
      found.push({ span: node.each, deferred: false }, ...node.key ? [{ span: node.key, deferred: false }] : [])
    }
    else if (node.kind === 'await') {
      found.push({ span: node.value, deferred: false })
    }
  })

  return found
}

function visit(nodes: Node[], each: (node: Node) => void): void {
  for (const node of nodes) {
    each(node)

    if (node.kind === 'element') {
      visit(node.children, each)
    }
    else if (node.kind === 'text') {
      visit(node.parts.filter(part => part.kind === 'element'), each)
    }
    else if (node.kind === 'if') {
      for (const branch of node.branches) {
        visit(branch.children, each)
      }
    }
    else if (node.kind === 'await') {
      for (const block of awaitBlocks(node)) {
        visit(block, each)
      }
    }
    else if (node.kind === 'try') {
      for (const block of tryBlocks(node)) {
        visit(block, each)
      }
    }
    else {
      visit([...node.children, ...(node.kind === 'for' ? node.fallback ?? [] : [])], each)
    }
  }
}

// A statement of the script reading the global as it runs wraps into `effect`, imported from `kay` when it is not yet; a declaration would take its name out of reach of the rest, so only an expression statement does.
function effectFix(file: KayFile, code: string, read: Read, effectBound: boolean, toSource: (generated: number) => number | undefined, ast: t.File): Fix[] {
  const statement = read.statement

  if (!file.script || statement?.type !== 'ExpressionStatement')
    return []

  // The expression alone: a statement ending the script takes the next template value's `;` with it.
  const start = toSource(statement.expression.start!)
  const end = toSource(statement.expression.end!)

  if (start === undefined || end === undefined || start < file.script.start || end > file.script.end)
    return []

  const expression = code.slice(statement.expression.start!, statement.expression.end!)
  const edits = [{ start, end, text: `effect(() => ${expression})` }]

  if (!effectBound) {
    const kay = ast.program.body.find((node): node is t.ImportDeclaration => node.type === 'ImportDeclaration' && node.source.value === 'kay' && node.importKind !== 'type' && node.specifiers.at(-1)?.type === 'ImportSpecifier')
    const last = kay && toSource(kay.specifiers.at(-1)!.end!)

    edits.unshift(last === undefined ? { start: file.script.start, end: file.script.start, text: 'import { effect } from \'kay\'\n\n' } : { start: last, end: last, text: ', effect' })
  }

  return [{ title: `Read \`${read.name}\` in an effect, once the component renders in the browser`, edits }]
}

// `---` becomes `--- client`; a file without a script gets an empty one.
function clientFix(file: KayFile): Fix[] {
  const title = 'Render the component in the browser only with `--- client`'

  if (!file.script)
    return [{ title, edits: [{ start: 0, end: 0, text: `${FENCE_OPENING} client\n${FENCE_OPENING}\n` }] }]

  const opening = file.source.lastIndexOf(FENCE_OPENING, file.script.start - 1) + FENCE_OPENING.length

  return [{ title, edits: [{ start: opening, end: opening, text: ' client' }] }]
}
