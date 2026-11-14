import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType, Program } from '../compiler/estree'
import type { LintName } from '../compiler/lints'
import type { Edit, Found } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { importedName, importsOf, walk } from './ast'
import { mentions, scan } from './renamed-exports'

const FROM_KAY = (source: string) => source === 'kay'
const COMMENT = /\/[*/]/
const PERSISTED = /\bpersisted\b/
const NAVIGATE = /\bnavigate\b/
const NAVIGATION_HOOK = /\bon(?:Before)?Navigate\b/
const LISTEN = /\blisten\b/
const MOVED_SOURCE = /kay\/(?:mount|server)/
const TRAILING_COMMA = /,$/

// What a rewritten `queryParam` call keeps of the old call's third argument: its members, or the whole value spread when it is not a plain object.
function keptSettings(source: string, base: number, settings: Node | undefined, inner: string | undefined): string {
  if (settings === undefined)
    return ''

  if (inner === undefined)
    return `, ...${source.slice(base + settings.start, base + settings.end)}`

  return inner === '' ? '' : `, ${inner}`
}

function keyName(key: Node): unknown {
  if (key.type === 'Identifier')
    return key.name

  return key.type === 'Literal' ? key.value : undefined
}

type Call = NodeOfType<'CallExpression'>
type ImportDeclaration = NodeOfType<'ImportDeclaration'>

// Whether `callee` is `name` imported from `kay` as written (`persisted`) or read off `import * as kay` (`kay.persisted`).
function calls(ast: Program, name: string): (callee: Node) => boolean {
  const { locals, namespaces } = importsOf(ast, FROM_KAY, name)

  return callee => callee.type === 'Identifier'
    ? locals.has(callee.name)
    : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === name
}

// Whether `callee` is `<name>.<member>` of `name` imported from `kay`.
function entryCalls(ast: Program, name: string, member: string): (callee: Node) => boolean {
  const { locals, namespaces } = importsOf(ast, FROM_KAY, name)

  return callee => callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === member
    && (callee.object.type === 'Identifier' ? locals.has(callee.object.name) : callee.object.type === 'MemberExpression' && !callee.object.computed && callee.object.object.type === 'Identifier' && namespaces.has(callee.object.object.name) && callee.object.property.type === 'Identifier' && callee.object.property.name === name)
}

// Calls `visit` on each call whose callee `is` accepts.
function eachCall(ast: Program, is: (callee: Node) => boolean, visit: (call: Call) => void): void {
  walk(ast, (node) => {
    if (node.type === 'CallExpression' && is(node.callee))
      visit(node)
  })
}

// How many identifiers named `name` the statements hold, imports left out: a rewrite of the calls alone would leave the others behind.
function reads(ast: Program, name: string): number {
  let found = 0

  for (const statement of ast.body) {
    if (statement.type === 'ImportDeclaration')
      continue

    walk(statement, (node) => {
      if (node.type === 'Identifier' && node.name === name)
        found++
    })
  }

  return found
}

// The import of `kay` that names `drops`, rebuilt without them and with `add`, which a file already importing it keeps as it is; a declaration of anything but plain named specifiers, an alias or a comment in the braces leaves it to the app (`null`).
function importEdits(ast: Program, base: number, source: string, drops: readonly string[], add: string): Edit[] | null {
  const declaration = ast.body.find((statement): statement is ImportDeclaration => statement.type === 'ImportDeclaration' && FROM_KAY(statement.source.value) && statement.importKind !== 'type' && statement.specifiers.some(specifier => specifier.type === 'ImportSpecifier' && (drops.length === 0 || drops.includes(importedName(specifier)))))

  if (!declaration || declaration.specifiers.some(specifier => specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type' || specifier.local.name !== importedName(specifier)))
    return null

  const specifiers = declaration.specifiers as NodeOfType<'ImportSpecifier'>[]
  const texts = specifiers.filter(specifier => !drops.includes(importedName(specifier))).map(specifier => source.slice(base + specifier.start, base + specifier.end))
  const imported = ast.body.some(statement => statement.type === 'ImportDeclaration' && FROM_KAY(statement.source.value) && statement.importKind !== 'type' && statement.specifiers.some(specifier => specifier.type === 'ImportSpecifier' && importedName(specifier) === add))
  const first = specifiers[0]!
  const last = specifiers.at(-1)!

  if (COMMENT.test(source.slice(base + first.start, base + last.end)))
    return null

  if (!imported)
    texts.push(add)

  if (texts.length === 0) {
    const after = source[base + declaration.end] === '\n' ? 1 : 0

    return [{ start: base + declaration.start, end: base + declaration.end + after, text: '' }]
  }

  return [{ start: base + first.start, end: base + last.end, text: texts.join(', ') }]
}

// Runs `visit` over the parsed spans of the files whose text matches `needle`, when the lint is not allowed.
async function scanned(root: string, options: CheckOptions, lint: LintName, needle: RegExp, visit: (found: Found) => void): Promise<CheckDiagnostic[]> {
  return lintLevel(lint, options.lints) === 'allow' ? [] : scan(root, options, lint, needle, visit)
}

// `persisted(name, value)`, a cookie since it began: `persisted.cookie(name, value)` names it, as `persisted.local()` and `persisted.session()` name theirs.
// A call with a `storage` option, which 1.105 no longer takes, is reported with no fix.
export async function persistedCall(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return scanned(root, options, 'deprecated-persisted-call', PERSISTED, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      eachCall(ast, calls(ast, 'persisted'), (call) => {
        const settings = call.arguments[2]
        const storage = settings?.type === 'ObjectExpression' && settings.properties.some(property => property.type === 'Property' && !property.computed && keyName(property.key) === 'storage')

        report(base + call.callee.start, base + call.callee.end, storage ? '`storage` of `persisted()` is removed since 1.105: each storage has its own entry' : '`persisted()` keeps a cookie without saying so since 1.105: `persisted.cookie()` names it', storage ? 'call `persisted.local()`, `persisted.session()` or `queryParam()`, or `persisted.cookie()` for a cookie' : 'call `persisted.cookie()`', storage ? null : [{ start: base + call.callee.end, end: base + call.callee.end, text: '.cookie' }])
      })
    }
  })
}

const QUERY_MEMBER = /\.persisted\.query$/

// Whether `call` reads `persisted.query` off a namespace import (`kay.persisted.query`).
const spelled = (call: Call): boolean => call.callee.type === 'MemberExpression' && call.callee.object.type === 'MemberExpression'

// `persisted.query(name, value, options)`, the signal of a query param twice: `queryParam(name, { default: value, ...options })` is the one.
export async function persistedQuery(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return scanned(root, options, 'deprecated-persisted-query', PERSISTED, ({ source, parsed, unparsed, report }) => {
    for (const { ast, base } of parsed) {
      const hits: Call[] = []

      eachCall(ast, entryCalls(ast, 'persisted', 'query'), call => hits.push(call))

      if (hits.length === 0)
        continue

      // `persisted` goes from the import when every use of it is such a call, and is kept otherwise.
      const { locals } = importsOf(ast, FROM_KAY, 'persisted')
      const others = [...locals].some(local => reads(ast, local) > hits.length || new RegExp(`\\b${local}\\b`).test(unparsed))
      const named = hits.filter(call => !spelled(call))
      const imports = named.length === 0 ? [] : importEdits(ast, base, source, others ? [] : ['persisted'], 'queryParam')

      for (const call of hits) {
        const [name, value, settings] = call.arguments
        const plain = call.arguments.length >= 2 && call.arguments.length <= 3 && !call.arguments.some(argument => argument.type === 'SpreadElement')
        const inner = settings?.type === 'ObjectExpression' && !settings.properties.some(property => property.type === 'SpreadElement') ? source.slice(base + settings.start + 1, base + settings.end - 1).trim().replace(TRAILING_COMMA, '') : undefined
        const kept = keptSettings(source, base, settings, inner)
        const text = plain ? `, { default: ${source.slice(base + value!.start, base + value!.end)}${kept} }` : undefined
        const lost = plain && COMMENT.test(source.slice(base + name!.end, base + call.end))
        const callee = spelled(call) ? `${source.slice(base + call.callee.start, base + call.callee.end).replace(QUERY_MEMBER, '')}.queryParam` : 'queryParam'
        const edits = plain && !lost && imports ? [{ start: base + call.callee.start, end: base + call.callee.end, text: callee }, { start: base + name!.end, end: base + call.end - 1, text: text! }, ...(spelled(call) ? [] : imports)] : null

        report(base + call.callee.start, base + call.callee.end, '`persisted.query()` is deprecated since 1.105: `queryParam()` is the one signal of a query param', 'call `queryParam(name, { default })`', edits)
      }
    }
  })
}

// `navigate({ query })`, one name for two jobs: `navigate.query(changes)` changes the query of the current page, `navigate(href)` goes to another.
export async function navigateQuery(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return scanned(root, options, 'deprecated-navigate-query', NAVIGATE, ({ source, parsed, report }) => {
    for (const { ast, base } of parsed) {
      eachCall(ast, calls(ast, 'navigate'), (call) => {
        const [changes] = call.arguments

        if (changes?.type !== 'ObjectExpression')
          return

        const [property] = changes.properties
        const only = changes.properties.length === 1 && property?.type === 'Property' && !property.computed && !property.method && property.kind === 'init' && keyName(property.key) === 'query'

        if (!only && !changes.properties.some(one => one.type === 'Property' && !one.computed && one.key.type === 'Identifier' && one.key.name === 'query'))
          return

        const text = only ? source.slice(base + property.value.start, base + property.value.end) : undefined
        const lost = only && COMMENT.test(source.slice(base + changes.start, base + changes.end))

        report(base + changes.start, base + changes.end, '`navigate({ query })` is deprecated since 1.105: `navigate.query()` changes the query, `navigate()` goes to a page', 'call `navigate.query(changes)`', only && !lost ? [{ start: base + call.callee.end, end: base + call.callee.end, text: '.query' }, { start: base + changes.start, end: base + changes.end, text: text! }] : null)
      })
    }
  })
}

const HOOKS = ['onBeforeNavigate', 'onNavigate'] as const

// `onNavigate(fn)` and `onBeforeNavigate(fn)`, hooks of the `navigation` source like the other sources' hooks: `navigation.onNavigate(fn)`.
// Moves the import too, unless a use of the name stays that is no call, or a `navigation` of the file's own stands in the way.
export async function navigationHooks(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return scanned(root, options, 'deprecated-navigation-hooks', NAVIGATION_HOOK, ({ source, parsed, unparsed, report }) => {
    for (const { ast, base } of parsed) {
      const hits = HOOKS.flatMap(hook => [...importsOf(ast, FROM_KAY, hook).locals].map(local => ({ hook, local })))

      if (hits.length === 0)
        continue

      const callees = new Set<Node>()

      for (const { local } of hits)
        eachCall(ast, callee => callee.type === 'Identifier' && callee.name === local, call => callees.add(call.callee))

      const read = hits.reduce((total, { local }) => total + reads(ast, local), 0)
      const text = parsed.map(one => one.ast)
      const blocked = hits.some(({ hook, local }) => local !== hook) || read !== callees.size || hits.some(({ local }) => new RegExp(`\\b${local}\\b`).test(unparsed)) || (mentions(text, 'navigation') && !importsOf(ast, FROM_KAY, 'navigation').locals.has('navigation'))
      const imports = blocked ? null : importEdits(ast, base, source, hits.map(({ hook }) => hook), 'navigation')

      for (const callee of callees) {
        if (callee.type !== 'Identifier')
          continue

        report(base + callee.start, base + callee.end, `\`${callee.name}()\` is deprecated since 1.105: the hooks of \`navigation\` are its methods`, `call \`navigation.${callee.name}()\``, imports ? [{ start: base + callee.start, end: base + callee.end, text: `navigation.${callee.name}` }, ...imports] : null)
      }
    }
  })
}

// `listen(window, ...)`, a target read once: `listen(() => window, ...)` is the one form, which a `.ts` module runs on the server and a signal or a `ref` follows.
export async function listenTarget(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return scanned(root, options, 'deprecated-listen-target', LISTEN, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      eachCall(ast, calls(ast, 'listen'), (call) => {
        const [target] = call.arguments

        if (!target || target.type === 'ArrowFunctionExpression' || target.type === 'FunctionExpression' || target.type === 'SpreadElement')
          return

        report(base + target.start, base + target.end, '`listen()` with a target given as a value is deprecated since 1.105: a function returning it is the one form', 'write `() => target`', [{ start: base + target.start, end: base + target.start, text: '() => ' }])
      })
    }
  })
}

// Where an export lives, when the entry an app imported it from is no longer its home: the name, the entry it left and the one it is imported from now.
const MOVED: Record<string, Record<string, string>> = {
  'kay/mount': { mount: 'kay', Mounted: 'kay' },
  'kay/server': { s: 'kay', RateLimit: 'kay', RateLimitRefusal: 'kay', sqliteCache: 'kay/cache' },
}

// A name imported from the entry that no longer owns it: each name has one home, `s` and `mount` in `kay`, `sqliteCache` in `kay/cache`.
// The fix takes the name out of the import and writes it as an import of its home, after it, keeping a `type` import and a `type` specifier as they were; an aliased import is rewritten the same.
export async function movedImports(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return scanned(root, options, 'deprecated-import-path', MOVED_SOURCE, ({ source, parsed, report }) => {
    for (const { ast, base } of parsed) {
      for (const statement of ast.body) {
        if (statement.type !== 'ImportDeclaration' || !Object.hasOwn(MOVED, statement.source.value))
          continue

        const homes = MOVED[statement.source.value]!
        const moved = statement.specifiers.filter((specifier): specifier is NodeOfType<'ImportSpecifier'> => specifier.type === 'ImportSpecifier' && Object.hasOwn(homes, importedName(specifier)))

        if (moved.length === 0)
          continue

        const left = statement.specifiers.filter(specifier => !moved.includes(specifier as never))
        const plain = left.every(specifier => specifier.type === 'ImportSpecifier')
        const lost = COMMENT.test(source.slice(base + statement.start, base + statement.end))
        const edits: Edit[] | null = !plain || lost ? null : []

        if (edits) {
          const kind = statement.importKind === 'type' ? 'import type' : 'import'
          const byHome = Map.groupBy(moved, specifier => homes[importedName(specifier)]!)
          const added = [...byHome].map(([home, specifiers]) => `${kind} { ${specifiers.map(specifier => source.slice(base + specifier.start, base + specifier.end)).join(', ')} } from '${home}'`).join('\n')
          const rest = left.length === 0 ? '' : `${source.slice(base + statement.start, base + (left[0] as Node).start)}${left.map(specifier => source.slice(base + specifier.start, base + specifier.end)).join(', ')}${source.slice(base + (left.at(-1) as Node).end, base + statement.end)}`

          edits.push({ start: base + statement.start, end: base + statement.end, text: rest === '' ? added : `${rest}\n${added}` })
        }

        for (const specifier of moved)
          report(base + specifier.start, base + specifier.end, `\`${importedName(specifier)}\` is exported from \`${homes[importedName(specifier)]}\`, its one home, since 1.105`, `import it from \`${homes[importedName(specifier)]}\``, edits)
      }
    }
  })
}
