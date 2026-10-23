// The checks a fence takes once parsed, beside what analyzing it reports: a schema field with no bound, a stylesheet imported for its text without asking, a page setting outside `page`.

import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic, Fix } from './ast'
import type { PageSettings, ParsedFence, SeparateSetting, ServerAnalysis } from './script'
import { isSecret } from '../runtime/form'
import { eachNode } from './each-node'
import { PAGE } from './page-settings'
import { patternNames } from './pattern-names'
import { walkScope } from './rewrite'
import { parseFence } from './script'

// A line break before a line with text: a blank line moving into `page` stays blank.
const LINE_WITH_TEXT = /\n(?=[^\n])/g
const NON_SPACE_OR_NEWLINE = /\S|\n/
// A path of the site: one slash then anything but a second slash or a backslash.
const SITE_PATH = /^\/(?![/\\])/
// The start of a path built from a value: a slash and a character that is no slash, as a value of `/evil.example` after a bare `/` makes `//evil.example`.
const BUILT_PATH = /^\/[^/\\]/

// Settings exported under their own names, with a fix moving every one it can into `page` at once: each diagnostic carries the same fix, applied once.
export function separatePageSettings(source: string, server: ServerAnalysis): Diagnostic[] {
  const { separate } = server

  // A fence naming a value `page` itself, as a paginated list often does, renames it before `page` can hold the settings.
  const taken = !server.page && (server.data.some(data => data.name === PAGE) || server.imports.some(binding => binding.local === PAGE))
  const movable = taken ? [] : separate.filter(setting => setting.movable && !server.page?.settings.has(setting.name))
  const fix = movable.length > 0 ? moveIntoPage(source, server.page, movable) : undefined

  return separate.map((setting) => {
    if (server.page?.settings.has(setting.name))
      return { ...setting.local, message: `\`${setting.name}\` is set twice, in \`page\` and on its own`, help: 'keep the one in `page`' }

    return {
      ...setting.local,
      message: `\`${setting.name}\` is a setting of \`page\`, not an export of its own`,
      note: 'one `export const page = { ... }` holds every setting of a page, typed and completed in the editor',
      help: taken ? `rename the fence's own \`page\`, then move it into \`export const page = { ${setting.name}: ... }\`` : `move it into \`export const page = { ${setting.name}: ... }\``,
      fixes: fix && movable.includes(setting) ? [fix] : [],
    }
  })
}

function moveIntoPage(source: string, page: PageSettings | undefined, settings: SeparateSetting[]): Fix {
  const entries = settings.map(setting => `${setting.name}: ${indentValue(setting.value)}`)
  const removals = settings.map(setting => ({ start: setting.statement.start, end: lineEnd(source, setting.statement.end), text: '' }))
  const title = `Move ${settings.length === 1 ? 'it' : 'them'} into \`page\``

  if (!page) {
    const [first, ...rest] = removals
    const single = entries.length === 1 && !entries[0]!.includes('\n')
    const text = single ? `export const page = { ${entries[0]} }\n` : `export const page = {\n${entries.map(entry => `  ${entry},\n`).join('')}}\n`

    return { title, edits: [{ ...first!, text }, ...rest], safe: true }
  }

  const inside = source.slice(page.object.start + 1, page.object.end - 1)
  const multiLine = inside.includes('\n')
  const trimmed = inside.trimEnd()
  const end = page.object.start + 1 + trimmed.length
  let text: string

  if (trimmed.trim() === '')
    text = multiLine ? `\n${entries.map(entry => `  ${entry},`).join('\n')}` : ` ${entries.join(', ')} `
  else if (multiLine)
    text = `${trimmed.endsWith(',') ? '' : ','}\n${entries.map(entry => `  ${entry},`).join('\n')}`
  else
    text = `${trimmed.endsWith(',') ? '' : ','} ${entries.join(', ')}`

  return { title, edits: [{ start: end, end, text }, ...removals], safe: true }
}

// A value moving into `page` one level deeper, unless a template literal's own lines would change with it.
function indentValue(value: string): string {
  return value.includes('`') ? value : value.replaceAll(LINE_WITH_TEXT, '\n  ')
}

// Past the line break ending a statement, so its line goes with it.
function lineEnd(source: string, end: number): number {
  const at = source.slice(end).search(NON_SPACE_OR_NEWLINE)

  return at !== -1 && source[end + at] === '\n' ? end + at + 1 : end
}

// What the quick fix bounds a string field to: room for a title or a name.
const SUGGESTED_MAX_LENGTH = 200

// Where and what to insert to bound a string field: a new options object, the first property of an empty one, or a property before the others.
function maxLengthEdit(call: t.CallExpression, options: t.CallExpression['arguments'][number] | undefined): { at: number, text: string } {
  if (options === undefined)
    return { at: call.end! - 1, text: `{ maxLength: ${SUGGESTED_MAX_LENGTH} }` }

  if (options.type === 'ObjectExpression' && options.properties.length === 0)
    return { at: options.start! + 1, text: ` maxLength: ${SUGGESTED_MAX_LENGTH} ` }

  return { at: (options as t.ObjectExpression).properties[0]!.start!, text: `maxLength: ${SUGGESTED_MAX_LENGTH}, ` }
}

// A string field of an action's schema with no `maxLength` takes whatever a visitor posts into it, up to the request body limit. A secret, such as a password, is checked or hashed rather than kept or shown, so it needs none.
export function unboundedFields(server: ServerAnalysis | undefined): Diagnostic[] {
  const fence = server?.fence

  if (!fence?.code.includes('String'))
    return []

  const diagnostics: Diagnostic[] = []

  eachNode(fence.ast.program, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'action' || !node.arguments[0] || node.arguments[0].type === 'ArrowFunctionExpression' || node.arguments[0].type === 'FunctionExpression')
      return

    schemaStrings(node.arguments[0], undefined, (call, field) => {
      const options = call.arguments[0]
      const known = options === undefined || (options.type === 'ObjectExpression' && options.properties.every(property => property.type !== 'SpreadElement'))

      if (!known || (options?.type === 'ObjectExpression' && options.properties.some(property => property.type !== 'SpreadElement' && propertyKey(property) === 'maxLength')) || (field !== undefined && isSecret(field)))
        return

      const edit = maxLengthEdit(call, options)
      const at = fence.offset + edit.at

      diagnostics.push({
        ...fence.shift(call.callee),
        code: 'unbounded-string',
        message: `${field === undefined ? 'This string field' : `The string field ${field}`} has no maxLength`,
        note: 'it takes whatever a visitor posts, up to the request body limit',
        help: 'give it one',
        fixes: [{ title: `Give it a maxLength of ${SUGGESTED_MAX_LENGTH}`, edits: [{ start: at, end: at, text: edit.text }] }],
        checkOnly: true,
      })
    })
  })

  return diagnostics
}

// The name a property key writes: an identifier read as written unless computed, or a string literal.
function memberName(key: t.Node, computed: boolean): string | undefined {
  if (key.type === 'StringLiteral')
    return key.value

  return key.type === 'Identifier' && !computed ? key.name : undefined
}

interface Named { name: string }

// The names a namespace import hands out that moved, read off it (`server.invalidatePage`, `server['invalidatePage']`) or destructured from it (`const { invalidatePage } = server`), as the node writing the name.
// Babel's scopes tell the namespace from an inner binding of the same name; a fence giving it none, a name declared twice, is read by name alone.
function namespaceReads<Entry extends Named>(fence: ParsedFence, namespaces: Map<t.ImportNamespaceSpecifier, Entry[]>): { key: t.Node, moved: Entry }[] {
  if (namespaces.size === 0)
    return []

  const found: { key: t.Node, moved: Entry }[] = []
  const movedBy = (object: t.Node | null | undefined, name: string | undefined, scope: NodePath['scope'] | undefined): Entry | undefined => {
    if (object?.type !== 'Identifier')
      return undefined

    const bound = scope?.getBinding(object.name)?.path.node
    const specifier = [...namespaces.keys()].find(entry => scope ? entry === bound : entry.local.name === object.name)

    return specifier && namespaces.get(specifier)?.find(entry => entry.name === name)
  }
  const destructured = (pattern: t.ObjectPattern, init: t.Node | null | undefined, scope: NodePath['scope'] | undefined) => {
    for (const property of pattern.properties) {
      if (property.type !== 'ObjectProperty')
        continue

      const moved = movedBy(init, memberName(property.key, property.computed), scope)

      if (moved)
        found.push({ key: property.key, moved })
    }
  }
  const visit = (node: t.Node, scope: NodePath['scope'] | undefined): void => {
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      const { property } = node
      const moved = movedBy(node.object, memberName(property, node.computed), scope)

      if (moved)
        found.push({ key: property, moved })
    }
    else if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern') {
      destructured(node.id, node.init, scope)
    }
    // `({ invalidatePage } = server)` and a parameter defaulting to the namespace, `({ invalidatePage } = server) => {}`.
    else if ((node.type === 'AssignmentExpression' || node.type === 'AssignmentPattern') && node.left.type === 'ObjectPattern') {
      destructured(node.left, node.right, scope)
    }
  }

  if (!walkScope(fence.ast, { enter: (path: NodePath) => visit(path.node, path.scope) })) {
    found.length = 0

    for (const statement of fence.ast.program.body)
      eachNode(statement, (node) => { visit(node, undefined) })
  }

  return found
}

// What `kay/cache` exports to the server alone: the browser's entry has `cached` and `invalidate`, though the types of the one entry name every export.
const SERVER_ONLY_CACHE = ['invalidatePage', 'sqliteCache']

// A server-only name of `kay/cache` imported by a fence that runs in the browser, which the build refuses with a missing export.
export function serverOnlyImports(fence: ParsedFence): Diagnostic[] {
  if (!fence.code.includes('kay/cache'))
    return []

  const diagnostics: Diagnostic[] = []
  const namespaces = new Map<t.ImportNamespaceSpecifier, Named[]>()
  const report = (node: t.Node, name: string) => diagnostics.push({
    ...fence.shift(node),
    code: 'server-only-import',
    message: `\`${name}\` is exported to the server alone, and this code runs in the browser`,
    note: 'the browser\'s `kay/cache` has `cached` and `invalidate`',
    help: 'call it from a `--- server` fence or an action, and keep this import there',
    checkOnly: true,
  })

  for (const node of fence.ast.program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== 'kay/cache' || node.importKind === 'type')
      continue

    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        namespaces.set(specifier, SERVER_ONLY_CACHE.map(name => ({ name })))
      }
      else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type') {
        const name = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value

        if (SERVER_ONLY_CACHE.includes(name))
          report(specifier, name)
      }
    }
  }

  for (const { key, moved } of namespaceReads(fence, namespaces))
    report(key, moved.name)

  return diagnostics
}

const CSS_BINDING = /\bimport\b[^;'"]+from\s*['"][^'"\n]+\.css['"]/

// A stylesheet imported for a value with no `with { type: 'text' }`: kay types it as the text it gives with the attribute, which Bun gives only with it.
export function cssImportsWithoutText(fence: ParsedFence): Diagnostic[] {
  if (!CSS_BINDING.test(fence.code))
    return []

  return fence.ast.program.body.flatMap((node) => {
    if (node.type !== 'ImportDeclaration' || !node.source.value.endsWith('.css') || node.specifiers.length === 0 || node.importKind === 'type')
      return []

    if ((node.attributes ?? []).some(({ key, value }) => (key.type === 'Identifier' ? key.name : key.value) === 'type' && value.value === 'text'))
      return []

    return [{
      ...fence.shift(node),
      code: 'css-import-without-text',
      message: `${node.source.value} is imported for a value without \`with { type: 'text' }\``,
      note: 'Bun gives such an import its text only with the attribute',
      help: 'add `with { type: \'text\' }` for the file\'s text, or import it with no name for the page\'s stylesheets',
      checkOnly: true,
    }]
  })
}

// Every `s.String(...)` call in a schema, with the name of the field it types, the nearest property holding it.
function schemaStrings(node: t.Node | null | undefined, field: string | undefined, found: (call: t.CallExpression, field: string | undefined) => void): void {
  eachNode(node, (inner) => {
    if (inner.type === 'ObjectProperty')
      schemaStrings(inner.value, propertyKey(inner) ?? field, found)
    else if (inner.type === 'CallExpression' && inner.callee.type === 'MemberExpression' && inner.callee.property.type === 'Identifier' && inner.callee.property.name === 'String')
      found(inner, field)

    // A property's value is walked above, under the property's own name.
    return inner.type !== 'ObjectProperty'
  })
}

function propertyKey(property: t.ObjectProperty | t.ObjectMethod): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'StringLiteral' ? property.key.value : undefined
}

const AI_PACKAGE = '@kaynooo/kayjs-ai'
const ASYNC_KEYWORD = /^(?:(?:static|public|private|protected|override)\s+)*(async\s*)/

type FunctionNode = t.ArrowFunctionExpression | t.FunctionExpression | t.FunctionDeclaration | t.ObjectMethod | t.ClassMethod | t.ClassPrivateMethod

function isFunction(node: t.Node): node is FunctionNode {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'ObjectMethod' || node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod'
}

// The values an expression may be: both branches of a condition, the operands of a logical expression, and what a type assertion or a non-null mark wraps.
function candidates(node: t.Node): t.Node[] {
  if (node.type === 'ConditionalExpression')
    return [...candidates(node.consequent), ...candidates(node.alternate)]

  if (node.type === 'LogicalExpression')
    return [...candidates(node.left), ...candidates(node.right)]

  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression' || node.type === 'ParenthesizedExpression')
    return candidates(node.expression)

  return [node]
}

interface Body {
  returned: t.Node[]
  awaits: boolean
  // The names the function declares itself, parameters included, and the `const` locals with their initializer.
  declared: Set<string>
  consts: Map<string, t.Node>
}

function declare(into: Set<string>, pattern: t.Node | null | undefined): void {
  for (const name of patternNames(pattern))
    into.add(name)
}

// What the function itself returns and whether it awaits, its inner functions left alone.
function returnsAndAwaits(fn: FunctionNode): Body {
  const returned: t.Node[] = fn.body.type === 'BlockStatement' ? [] : [fn.body]
  const declared = new Set<string>()
  const consts = new Map<string, t.Node>()
  let awaits = false

  for (const param of fn.params)
    declare(declared, param)

  eachNode(fn.body, (node) => {
    if (isFunction(node)) {
      if (node.type === 'FunctionDeclaration' && node.id)
        declared.add(node.id.name)

      return false
    }

    if (node.type === 'ReturnStatement' && node.argument) {
      returned.push(node.argument)
    }
    else if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await)) {
      awaits = true
    }
    else if (node.type === 'VariableDeclarator') {
      declare(declared, node.id)
    }
    else if (node.type === 'CatchClause') {
      declare(declared, node.param)
    }
    else if (node.type === 'ClassDeclaration' && node.id) {
      declared.add(node.id.name)
    }
    else if (node.type === 'VariableDeclaration' && node.kind === 'const') {
      for (const declaration of node.declarations) {
        if (declaration.id.type === 'Identifier' && declaration.init)
          consts.set(declaration.id.name, declaration.init)
      }
    }

    return true
  })

  return { returned: returned.flatMap(candidates), awaits, declared, consts }
}

// Whether the call's callee, or the namespace it is read from, is declared by the function itself, so the call is not the import's.
function shadowed(declared: Set<string>, call: t.CallExpression): boolean {
  const { callee } = call
  const root = callee.type === 'MemberExpression' ? callee.object : callee

  return root.type === 'Identifier' && declared.has(root.name)
}

// An `async` function returning `ask()` from kayjs-ai: the async function awaits the reply, which is a thenable, so the answer arrives as its whole text and the action or `await` block reading it never streams. Without an `await` in it, `async` can go; with one, the reply is returned as `.stream()`.
export function asyncReplies(fence: ParsedFence): Diagnostic[] {
  if (!fence.code.includes(AI_PACKAGE) || !fence.code.includes('async'))
    return []

  const names = new Set<string>()
  const namespaces = new Set<string>()

  for (const node of fence.ast.program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== AI_PACKAGE || node.importKind === 'type')
      continue

    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier')
        namespaces.add(specifier.local.name)
      else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === 'ask')
        names.add(specifier.local.name)
    }
  }

  if (names.size === 0 && namespaces.size === 0)
    return []

  const isAsk = (node: t.Node): node is t.CallExpression => node.type === 'CallExpression' && (node.callee.type === 'Identifier'
    ? names.has(node.callee.name)
    : node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier' && namespaces.has(node.callee.object.name) && node.callee.property.type === 'Identifier' && node.callee.property.name === 'ask')
  const diagnostics: Diagnostic[] = []

  eachNode(fence.ast.program, (node) => {
    if (!isFunction(node) || !node.async || ('generator' in node && node.generator))
      return

    const { returned, awaits, declared, consts } = returnsAndAwaits(node)
    const keyword = ASYNC_KEYWORD.exec(fence.code.slice(node.start!))
    // A local `const` holding the reply and returned is the reply.
    const values = returned.flatMap(value => value.type === 'Identifier' && consts.has(value.name) ? candidates(consts.get(value.name)!) : [value])
    const call = values.find(isAsk)

    // A binding named like the import is something else.
    if (call && !shadowed(declared, call)) {
      diagnostics.push({
        ...fence.shift(call),
        code: 'async-reply',
        message: 'This `ask()` is returned from an `async` function, which awaits it: the answer arrives as its whole text, with no streaming',
        note: 'the reply is a thenable async iterable, and an action or an `await` block streams it only when it is returned as it is',
        help: awaits ? 'return `ask(...).stream()`, which an `async` function hands on as it is; `return await ask(...)` says the whole text is meant' : 'remove `async`, or write `return await ask(...)` when the whole text is meant',
        fixes: !awaits && keyword && !node.returnType && values.every(isAsk) ? [{ title: 'Remove `async`', edits: [{ start: fence.offset + node.start! + keyword.index + keyword[0].length - keyword[1]!.length, end: fence.offset + node.start! + keyword[0].length, text: '' }], safe: true }] : [],
      })
    }
  })

  return diagnostics
}

// The values of a template that follow its first one with no text between: they extend the prefix, where later ones follow text the prefix already ended with.
function adjacent(node: t.TemplateLiteral): t.Node[] {
  const found: t.Node[] = []

  for (let at = 1; at < node.expressions.length && (node.quasis[at]!.value.cooked ?? '') === ''; at++)
    found.push(node.expressions[at]!)

  return found
}

// The checkers that turn any value into a path of this site: kay's `localPath` and the auth library's `safeRedirect`.
const SITE_CHECKERS = new Set(['localPath', 'safeRedirect'])

// Whether a redirect target is written as a path of this site: a literal starting with one slash, a template or a concatenation whose text before the first value is `/` and a name (`/posts/`) or whose first value is itself a site path, a call to a checker, `localize(...)` of a site path, or a `const` holding one.
function isSitePath(node: t.Node, constants: Scope, seen = new Set<readonly t.Node[]>()): boolean {
  const site = (inner: t.Node) => isSitePath(inner, constants, seen)

  if (node.type === 'StringLiteral')
    return SITE_PATH.test(node.value)

  if (node.type === 'TemplateLiteral') {
    const first = node.quasis[0]!.value.cooked ?? ''

    if (node.expressions.length === 0)
      return SITE_PATH.test(first)

    return first === '' ? site(node.expressions[0]!) && adjacent(node).every(inner => !readsRequest(inner, constants, new Set())) : BUILT_PATH.test(first)
  }

  if (node.type === 'BinaryExpression' && node.operator === '+')
    return node.left.type === 'StringLiteral' ? BUILT_PATH.test(node.left.value) : site(node.left) && (node.left.type === 'BinaryExpression' || node.left.type === 'CallExpression' || node.left.type === 'Identifier') && !readsRequest(node.right, constants, new Set())

  if (node.type === 'ConditionalExpression')
    return site(node.consequent) && site(node.alternate)

  if (node.type === 'LogicalExpression')
    return site(node.left) && site(node.right)

  if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression' || node.type === 'ParenthesizedExpression')
    return site(node.expression)

  if (node.type === 'Identifier') {
    const hit = constants.resolve(node.name)

    if (!hit || seen.has(hit.inits))
      return false

    seen.add(hit.inits)

    const site = hit.inits.every(init => isSitePath(init, hit.scope, seen))

    seen.delete(hit.inits)

    return site
  }

  if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier')
    return false

  if (SITE_CHECKERS.has(node.callee.name))
    return true

  const [first] = node.arguments

  return node.callee.name === 'localize' && first !== undefined && first.type !== 'SpreadElement' && site(first)
}

// The variables one block, function or catch clause declares: a name's initialisers, or no value known for it (a parameter, a pattern, an assigned name).
class Scope {
  readonly inits = new Map<string, t.Node[]>()
  readonly unknown = new Set<string>()

  constructor(readonly parent?: Scope, readonly isFunction = true) {}

  // The scope that declares a name and what it holds there; undefined when the name is unknown or declared in no scope.
  resolve(name: string): { inits: readonly t.Node[], scope: Scope } | undefined {
    if (this.unknown.has(name))
      return undefined

    const inits = this.inits.get(name)

    return inits ? { inits, scope: this } : this.parent?.resolve(name)
  }

  declaring(name: string): Scope | undefined {
    return this.unknown.has(name) || this.inits.has(name) ? this : this.parent?.declaring(name)
  }

  // `var` belongs to the function around it, `const` and `let` to the block.
  get hoist(): Scope {
    return this.isFunction || !this.parent ? this : this.parent.hoist
  }
}

function opensScope(node: t.Node): boolean {
  return isFunction(node) || node.type === 'BlockStatement' || node.type === 'CatchClause' || node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement' || node.type === 'SwitchStatement' || node.type === 'StaticBlock'
}

// The names a function's parameters or a catch clause's parameter bind.
function boundNames(node: t.Node): string[] {
  if (isFunction(node))
    return node.params.flatMap(param => patternNames(param))

  return node.type === 'CatchClause' ? patternNames(node.param) : []
}

function declareIn(node: t.Node, scope: Scope, scopes: Map<t.Node, Scope>): void {
  eachNode(node, (inner, parent) => {
    if (inner !== node && opensScope(inner)) {
      const own = new Scope(scope, isFunction(inner))

      scopes.set(inner, own)
      declareIn(inner, own, scopes)

      return false
    }

    if (inner === node) {
      for (const name of boundNames(inner))
        scope.unknown.add(name)
    }
    else if (inner.type === 'VariableDeclarator' && inner.id.type === 'Identifier' && inner.init) {
      const target = parent?.type === 'VariableDeclaration' && parent.kind === 'var' ? scope.hoist : scope

      target.inits.set(inner.id.name, [...target.inits.get(inner.id.name) ?? [], inner.init])
    }
    else if (inner.type === 'VariableDeclarator') {
      const target = parent?.type === 'VariableDeclaration' && parent.kind === 'var' ? scope.hoist : scope

      for (const name of patternNames(inner.id))
        target.unknown.add(name)
    }
    else if ((inner.type === 'FunctionDeclaration' || inner.type === 'ClassDeclaration') && inner.id) {
      scope.unknown.add(inner.id.name)
    }
    else if (inner.type === 'ImportSpecifier' || inner.type === 'ImportDefaultSpecifier' || inner.type === 'ImportNamespaceSpecifier') {
      scope.unknown.add(inner.local.name)
    }

    return true
  })
}

// Visits every node of `node` with the scope it is written in.
function eachScoped(node: t.Node, scope: Scope, scopes: ReadonlyMap<t.Node, Scope>, visit: (node: t.Node, scope: Scope) => void): void {
  eachNode(node, (inner) => {
    const own = inner === node ? undefined : scopes.get(inner)

    if (own) {
      eachScoped(inner, own, scopes, visit)

      return false
    }

    visit(inner, scope)

    return true
  })
}

// The variables of a fence by scope, a name assigned after it is declared holding nothing known.
function scopesOf(fence: ParsedFence): { root: Scope, scopes: Map<t.Node, Scope> } {
  const root = new Scope()
  const scopes = new Map<t.Node, Scope>()

  declareIn(fence.ast.program, root, scopes)

  eachScoped(fence.ast.program, root, scopes, (node, scope) => {
    if (node.type !== 'AssignmentExpression')
      return

    for (const name of patternNames(node.left))
      (scope.declaring(name) ?? root).unknown.add(name)
  })

  return { root, scopes }
}

const REQUEST_CONTEXT = new Set(['query', 'params', 'body', 'request', 'url', 'input', 'headers', 'cookies', 'form'])
// What a visitor posts, bare or by member: a call result built from it (a sign-in checking a form) is not followed back to it, which a direct `redirect(input.next)` still is.
const POSTED = new Set(['input', 'body', 'form', 'formData'])
const REQUEST_ROOTS = new Set(['query', 'params', 'body', 'input', 'request', 'searchParams', 'formData'])
// Names that are the request only when destructured from the context, not when the code declares them itself.
const DESTRUCTURED_ROOTS = new Set(['url', 'headers', 'cookies'])

function isRoot(name: string, constants: Scope): boolean {
  return REQUEST_ROOTS.has(name) || (DESTRUCTURED_ROOTS.has(name) && !constants.resolve(name))
}

// A call result is a value the callee made: a request member it was given taints it, the bare request object (an action's `input`) does not.
function isCall(node: t.Node): boolean {
  return node.type === 'AwaitExpression' ? isCall(node.argument) : node.type === 'CallExpression'
}

// The name a member access reads: `.query` or `['query']`.
function accessedName(property: t.Node, computed: boolean): string | undefined {
  if (property.type === 'Identifier' && !computed)
    return property.name

  return property.type === 'StringLiteral' ? property.value : undefined
}

// Whether a node reads the request: `ctx.query...`, `ctx.url...`, a destructured `query` or a `const` holding one.
function readsRequest(node: t.Node, constants: Scope, seen: Set<readonly t.Node[]>, bare = true): boolean {
  let found = false

  eachNode(node, (inner, parent) => {
    if (found)
      return false

    // A property name or an object key is no variable.
    if (inner.type === 'Identifier' && parent !== undefined && ((parent.type === 'MemberExpression' && parent.property === inner && !parent.computed) || (parent.type === 'OptionalMemberExpression' && parent.property === inner && !parent.computed) || (parent.type === 'ObjectProperty' && parent.key === inner && !parent.computed && !parent.shorthand)))
      return true

    // What a checker returns is a path of the site, whatever it was given.
    if (inner.type === 'CallExpression' && inner.callee.type === 'Identifier' && SITE_CHECKERS.has(inner.callee.name))
      return false

    if (inner.type === 'MemberExpression' || inner.type === 'OptionalMemberExpression') {
      let base: t.Node = inner
      let first: t.Node = inner

      while ((base.type === 'MemberExpression' || base.type === 'OptionalMemberExpression')) {
        first = base
        base = base.object
      }

      const member = 'property' in first ? accessedName(first.property, first.computed) : undefined

      if (base.type === 'Identifier' && member !== undefined)
        found = base.name === 'ctx' ? REQUEST_CONTEXT.has(member) && (bare || !POSTED.has(member)) : isRoot(base.name, constants) && (bare || !POSTED.has(base.name))
    }
    else if (bare && inner.type === 'Identifier' && isRoot(inner.name, constants)) {
      found = true
    }
    else if (inner.type === 'Identifier') {
      const hit = constants.resolve(inner.name)

      if (hit && !seen.has(hit.inits)) {
        seen.add(hit.inits)
        found = hit.inits.some(init => readsRequest(init, hit.scope, seen, bare && !isCall(init)))
        seen.delete(hit.inits)
      }
    }

    return !found
  })

  return found
}

// Whether a target that is not written as a site path may be any URL: a literal or text that is not a path, an unknown name, a member of the request, or a call fed the request.
// A value a helper builds from the app's own values (`organizationPage(features, org)`, `result.redirect`) is left alone, as it does not come from the visitor.
function leaks(node: t.Node, constants: Scope, seen = new Set<readonly t.Node[]>()): boolean {
  const next = (inner: t.Node) => leaks(inner, constants, seen)

  if (isSitePath(node, constants))
    return false

  if (node.type === 'TemplateLiteral') {
    const first = node.quasis[0]!.value.cooked ?? ''

    return first === '' ? next(node.expressions[0]!) || adjacent(node).some(inner => readsRequest(inner, constants, new Set())) : !BUILT_PATH.test(first)
  }

  if (node.type === 'BinaryExpression' && node.operator === '+')
    return node.left.type === 'StringLiteral' ? !BUILT_PATH.test(node.left.value) : next(node.left) || readsRequest(node.right, constants, new Set())

  if (node.type === 'ConditionalExpression')
    return next(node.consequent) || next(node.alternate)

  if (node.type === 'LogicalExpression')
    return next(node.left) || next(node.right)

  if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression' || node.type === 'ParenthesizedExpression' || node.type === 'AwaitExpression')
    return next('expression' in node ? node.expression : node.argument)

  if (node.type === 'NullLiteral' || (node.type === 'Identifier' && node.name === 'undefined'))
    return false

  if (node.type === 'Identifier') {
    const hit = constants.resolve(node.name)

    if (!hit || seen.has(hit.inits))
      return true

    seen.add(hit.inits)

    const leaking = hit.inits.some(init => leaks(init, hit.scope, seen))

    seen.delete(hit.inits)

    return leaking
  }

  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression' || node.type === 'CallExpression' || node.type === 'OptionalCallExpression')
    return readsRequest(node, constants, new Set())

  return true
}

// A `redirect()` or `ctx.redirect()` whose target is not written as a path of the site: a value read from the request or a store may be any URL, an open redirect for a phishing link.
export function openRedirects(fence: ParsedFence): Diagnostic[] {
  if (!fence.code.includes('redirect('))
    return []

  const diagnostics: Diagnostic[] = []
  const { root, scopes } = scopesOf(fence)

  eachScoped(fence.ast.program, root, scopes, (node, constants) => {
    if (node.type !== 'CallExpression' || !node.arguments[0] || node.arguments[0].type === 'SpreadElement')
      return

    const callee = node.callee
    const redirects = callee.type === 'Identifier' ? callee.name === 'redirect' : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.object.name === 'ctx' && callee.property.type === 'Identifier' && callee.property.name === 'redirect'

    if (!redirects || !leaks(node.arguments[0], constants))
      return

    diagnostics.push({
      ...fence.shift(node.arguments[0]),
      code: 'external-redirect',
      checkOnly: true,
      message: 'This redirect goes where its value says, which may be any site',
      note: 'a target read from the request is an open redirect when it is a full URL: a link on your domain sends a visitor to a phishing page',
      help: 'wrap a `?next=` value in `localPath(value, fallback)`, or write `// kay-allow external-redirect` for a URL you chose',
    })
  })

  return diagnostics
}

// The checks a plain module takes, parsed only when one of them may find something.
// A module the browser bundle reaches (`browser`) is checked for the names the browser's entries lack as well.
export function moduleChecks(source: string, browser = false): Diagnostic[] {
  if (!CSS_BINDING.test(source) && !(browser && source.includes('kay/cache')) && !(source.includes(AI_PACKAGE) && source.includes('async')) && !source.includes('redirect('))
    return []

  const whole = { start: 0, end: source.length }
  const recovered = parseFence(source, whole, [], false)

  // Babel's own recovery keeps every statement for the checks; a module it cannot read, or whose scopes it cannot build, is read again with its broken statements blanked.
  try {
    if (recovered)
      return checksOf(recovered, browser)
  }
  catch {}

  const module = parseFence(source, whole, [])

  return module ? checksOf(module, browser) : []
}

function checksOf(module: ParsedFence, browser: boolean): Diagnostic[] {
  return [...cssImportsWithoutText(module), ...asyncReplies(module), ...openRedirects(module), ...browser ? serverOnlyImports(module) : []]
}
