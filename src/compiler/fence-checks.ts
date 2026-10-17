// The checks a fence takes once parsed, beside what analyzing it reports: a schema field with no bound, a stylesheet imported for its text without asking, a page setting outside `page`.

import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic, Fix } from './ast'
import type { PageSettings, ParsedFence, SeparateSetting, ServerAnalysis } from './script'
import { isSecret } from '../runtime/form'
import { PAGE } from './page-settings'
import { loadTraverse } from './rewrite'
import { eachNode, parseFence } from './script'

// A line break before a line with text: a blank line moving into `page` stays blank.
const LINE_WITH_TEXT = /\n(?=[^\n])/g
const NON_SPACE_OR_NEWLINE = /\S|\n/

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

  try {
    loadTraverse()(fence.ast, { enter: (path: NodePath) => visit(path.node, path.scope) })
  }
  catch {
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

const SIGN_IN_CALL = /\b(?:signInWithPassword|requestMagicLink|signInWithPasskey|createAuth)\b|\bauth\.register\b/
// What a way of signing in of kayjs-auth took in its input before 1.52, which is its trailing options object now.
const INPUT_OPTIONS: Record<string, string[]> = { signInWithPassword: ['redirect', 'remember', 'captcha'], register: ['remember', 'captcha'] }
// The ones whose redirect was a positional argument after the first.
const POSITIONAL_REDIRECT = new Set(['requestMagicLink', 'signInWithPasskey'])

// A call of kayjs-auth's `signInWithPassword`, `register`, `requestMagicLink` or `signInWithPasskey` in the form of before 1.52: the redirect, remember and captcha in the input or as a positional redirect, where they are the trailing options object now.
// Read by name, as the `auth` of `ctx.locals.auth` is typed by the app; `register` only on a receiver named `auth`, as it is a common name.
export function staleAuthCalls(fence: ParsedFence): Diagnostic[] {
  if (!SIGN_IN_CALL.test(fence.code))
    return []

  const diagnostics: Diagnostic[] = []

  eachNode(fence.ast.program, (node) => {
    const hook = node.type === 'CallExpression' ? staleEventHook(node) : undefined

    if (hook) {
      diagnostics.push({
        ...fence.shift(hook),
        code: 'deprecated-auth-event',
        message: '`onEvent` of `createAuth` is `onAuthEvent` since 1.52, which gets one object instead of four arguments',
        help: 'write `onAuthEvent: ({ event, user, context, ...fields }) => ...`: the parts of the old `detail` are fields of the object, such as `role`, `method`, `provider` or `organizationId`',
        checkOnly: true,
      })
    }

    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed || node.callee.property.type !== 'Identifier' || node.arguments.some(argument => argument.type === 'SpreadElement'))
      return

    const { callee } = node
    const name = (callee.property as t.Identifier).name

    const keys = INPUT_OPTIONS[name]

    if (name === 'register' && receiverName(callee.object) !== 'auth')
      return

    const edit = keys ? inputOptionsEdit(fence.code, node.arguments, keys) : positionalRedirectEdit(fence.code, name, node.arguments)

    if (!edit)
      return

    diagnostics.push({
      ...fence.shift(callee.property),
      code: 'deprecated-sign-in-options',
      message: keys ? `\`${name}\` takes ${keys.map(key => `\`${key}\``).join(', ')} in an options object after the input since 1.52, not in the input` : `\`${name}\` takes its redirect in the options object since 1.52, not as an argument of its own`,
      help: 'move them into one trailing options object: `{ redirect, remember, captcha }`',
      fixes: [{ title: 'Use the options object', edits: [{ start: fence.offset + edit.start, end: fence.offset + edit.end, text: edit.text }], safe: edit.safe }],
      checkOnly: true,
    })
  })

  return diagnostics
}

// The `onEvent` key of the options object a `createAuth(...)` call is given.
function staleEventHook(call: t.CallExpression): t.Node | undefined {
  const { callee } = call
  const named = callee.type === 'Identifier' ? callee.name === 'createAuth' : callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'createAuth'
  const options = call.arguments[0]

  if (!named || options?.type !== 'ObjectExpression')
    return undefined

  const found = options.properties.find((property): property is t.ObjectProperty | t.ObjectMethod => property.type !== 'SpreadElement' && propertyKey(property) === 'onEvent')

  return found?.key
}

// The name the receiver of a call ends on: `auth` in `auth.x()` and in `ctx.locals.auth.x()`.
function receiverName(object: t.Node): string | undefined {
  if (object.type === 'Identifier')
    return object.name

  return object.type === 'MemberExpression' && !object.computed && object.property.type === 'Identifier' ? object.property.name : undefined
}

interface CallEdit {
  start: number
  end: number
  text: string
  safe: boolean
}

function source(code: string, node: t.Node): string {
  return code.slice(node.start!, node.end!)
}

// `f({ a, redirect })` as `f({ a }, { redirect })`: the moved properties leave the input, the others keep the text around them, and an options argument already there takes them in front of its own properties, which win as they do at run time. Safe unless the input or the options have a spread or a computed key, or the options are not an object literal: a spread may hold one of the moved names the property no longer overrides. A moved field the options also set is dropped, as the options win.
function inputOptionsEdit(code: string, args: t.CallExpression['arguments'], keys: string[]): CallEdit | undefined {
  const input = args[0]

  const second = args[1]
  const given = second?.type === 'Identifier' && second.name === 'undefined' ? undefined : second

  if (args.length > 2 || input?.type !== 'ObjectExpression')
    return undefined

  const { properties } = input
  const moved = properties.filter(property => property.type === 'ObjectProperty' && !property.computed && keys.includes(propertyKey(property) ?? ''))

  if (moved.length === 0)
    return undefined

  // What opened the object, then each kept property after the text that stood between it and the property before it.
  let rebuilt = code.slice(input.start!, properties[0]!.start!)
  let first = true

  for (const [index, property] of properties.entries()) {
    if (moved.includes(property))
      continue

    rebuilt += `${first ? '' : code.slice(properties[index - 1]!.end!, property.start!)}${source(code, property)}`
    first = false
  }

  const movedText = moved.map(property => source(code, property)).join(', ')
  const safeInput = properties.every(property => property.type === 'ObjectProperty' && !property.computed)

  // What closed the object, from the end of its last property: its trailing comma and line break stay. An emptied input is `{}`.
  const inputText = moved.length === properties.length ? '{}' : `${rebuilt}${code.slice(properties.at(-1)!.end!, input.end!)}`

  if (!given)
    return { start: input.start!, end: (second ?? input).end!, text: `${inputText}, { ${movedText} }`, safe: safeInput }

  if (given.type === 'ObjectExpression') {
    const own = given.properties.map(property => source(code, property))
    const overridden = new Set(given.properties.map(property => property.type === 'ObjectProperty' && !property.computed ? propertyKey(property) : undefined))
    const carried = moved.filter(property => !overridden.has(propertyKey(property as t.ObjectProperty))).map(property => source(code, property))
    const safeOptions = given.properties.every(property => property.type === 'ObjectProperty' && !property.computed)

    return { start: input.start!, end: given.end!, text: `${inputText}, { ${[...carried, ...own].join(', ')} }`, safe: safeInput && safeOptions }
  }

  // A variable may hold `undefined` for a field, which would override the moved one.
  return { start: input.start!, end: given.end!, text: `${inputText}, { ${movedText}, ...${source(code, given)} }`, safe: false }
}

// `f(email, redirect, { remember })` as `f(email, { redirect, remember })`.
function positionalRedirectEdit(code: string, name: string, args: t.CallExpression['arguments']): CallEdit | undefined {
  const [first, redirect, options] = args

  if (!POSITIONAL_REDIRECT.has(name) || !first || !redirect || args.length > 3 || redirect.type === 'ObjectExpression')
    return undefined

  // A second argument that is a variable or a call may already be the options object, so only a string, a template or `undefined` is read as the old redirect.
  const literal = redirect.type === 'StringLiteral' || redirect.type === 'TemplateLiteral' || (redirect.type === 'Identifier' && redirect.name === 'undefined')

  if (args.length === 2 && !literal)
    return undefined

  const parts: string[] = []

  if (!(redirect.type === 'Identifier' && redirect.name === 'undefined'))
    parts.push(redirect.type === 'Identifier' && redirect.name === 'redirect' ? 'redirect' : `redirect: ${source(code, redirect)}`)

  let safe = true

  if (options?.type === 'ObjectExpression') {
    parts.push(...options.properties.map(property => source(code, property)))
    safe = options.properties.every(property => property.type === 'ObjectProperty' && !property.computed)
  }
  else if (options) {
    parts.push(`...${source(code, options)}`)
    safe = false
  }

  return { start: first.end!, end: args.at(-1)!.end!, text: parts.length === 0 ? '' : `, { ${parts.join(', ')} }`, safe }
}

// The checks a plain module takes, parsed only when one of them may find something.
// A module the browser bundle reaches (`browser`) is checked for the names the browser's entries lack as well.
export function moduleChecks(source: string, browser = false): Diagnostic[] {
  if (!CSS_BINDING.test(source) && !(browser && source.includes('kay/cache')) && !SIGN_IN_CALL.test(source))
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
  return [...cssImportsWithoutText(module), ...staleAuthCalls(module), ...browser ? serverOnlyImports(module) : []]
}
