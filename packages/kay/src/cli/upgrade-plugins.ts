// `kay upgrade` for #3579: a stateful plugin is registered as the handle its `createX()` returns, and two factories took the `createX()`/`x()` names.

import type { AstNode } from '../compiler/analyze'
import { parseTsx, walk } from '../compiler/analyze'
import { SourceEditor } from '../compiler/patch'

const RENAMED_FACTORIES = new Map([
  ['@kayjs/mail', new Map([['mailer', 'createMailer']])],
  ['@kayjs/content', new Map([['contentPlugin', 'content']])],
])
// `mailPlugin(mail)` registered the mailer, which is now the plugin itself.
const UNWRAPPED = { module: '@kayjs/mail', name: 'mailPlugin' }

type Import = Extract<AstNode, { type: 'ImportDeclaration' }>
type Specifier = Extract<AstNode, { type: 'ImportSpecifier' }>

interface Binding {
  spec: Specifier
  imported: string
  /** What `imported` is called now: a new name, or null for an export that is gone. */
  renamed: string | null
  refs: AstNode[]
  /** Used where a rename would change more than the binding: a shorthand property or an export specifier. */
  pinned: boolean
}

export function lineOf(code: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i++) {
    if (code.charCodeAt(i) === 10)
      line++
  }
  return line
}

const nameOf = (node: { type: string, name?: string, value?: unknown }): string => node.type === 'Identifier' ? node.name! : String(node.value)

/** Rewrites one source file; each registration it cannot rewrite is pushed to `manual` as `file:line: what`. */
export function upgradePluginHandles(file: string, code: string, manual: string[]): string {
  if (!code.includes('@kayjs/') && !code.includes('.plugin'))
    return code
  const program = parseTsx(file, code)
  const bindings = new Map<string, Binding>()
  for (const stmt of program.body) {
    if (stmt.type !== 'ImportDeclaration')
      continue
    for (const spec of stmt.specifiers) {
      if (spec.type !== 'ImportSpecifier')
        continue
      const imported = nameOf(spec.imported)
      const renamed = RENAMED_FACTORIES.get(stmt.source.value)?.get(imported)
      const gone = stmt.source.value === UNWRAPPED.module && imported === UNWRAPPED.name
      if (renamed !== undefined || gone)
        bindings.set(spec.local.name, { spec, imported, renamed: renamed ?? null, refs: [], pinned: false })
    }
  }

  const editor = new SourceEditor(code)
  const names = new Set<string>()
  const skipped = new Set<number>()
  const reports: [number, string][] = []
  const pin = (name: string): void => {
    const binding = bindings.get(name)
    if (binding !== undefined)
      binding.pinned = true
  }
  walk(program.body, (node) => {
    if (node.type === 'ImportDeclaration')
      return false
    // Every keyed node (property, method, class field, type member) names its key, which is no reference.
    const keyed = node as AstNode & { key?: AstNode & { type: string, name?: string }, computed?: boolean, shorthand?: boolean }
    if (keyed.key !== undefined && keyed.computed === false) {
      if (keyed.shorthand === true)
        pin(nameOf(keyed.key))
      skipped.add(keyed.key.start)
    }
    if (node.type === 'MemberExpression' && !node.computed)
      skipped.add(node.property.start)
    if (node.type === 'ExportSpecifier')
      pin(nameOf(node.local))
    if (node.type === 'Property' && node.key.type === 'Identifier' && node.key.name === 'plugins' && node.value.type === 'ArrayExpression')
      registerHandles(code, node.value.elements, bindings, editor, skipped, reports)
    if (node.type === 'Identifier') {
      names.add(node.name)
      if (!skipped.has(node.start))
        bindings.get(node.name)?.refs.push(node)
    }
    return true
  })

  const removedLines: number[] = []
  for (const stmt of program.body) {
    if (stmt.type === 'ImportDeclaration')
      rewriteImport(code, stmt, bindings, names, editor, removedLines)
  }
  for (const [offset, what] of reports)
    manual.push(`${file}:${lineOf(code, offset) - removedLines.filter(start => start < offset).length}: ${what}`)
  return editor.toString()
}

// In a `plugins` array, `x.plugin` and `x.plugin()` become `x`, and so does `mailPlugin(x)`.
function registerHandles(code: string, elements: readonly (AstNode | null)[], bindings: Map<string, Binding>, editor: SourceEditor, skipped: Set<number>, reports: [number, string][]): void {
  for (const el of elements) {
    if (el === null)
      continue
    const call = el.type === 'CallExpression' ? el : undefined
    const member = call?.callee ?? el
    if (member.type === 'MemberExpression' && member.property.type === 'Identifier' && member.property.name === 'plugin' && !member.computed && member.object.type === 'Identifier') {
      const handle = member.object.name
      if (call === undefined || call.arguments.length === 0)
        editor.replace(el.start, el.end, handle)
      else
        reports.push([el.start, `register ${handle} itself and move the options of ${handle}.plugin(...) into the createX() call that made it.`])
      continue
    }
    const unwrap = call !== undefined && call.callee.type === 'Identifier' ? bindings.get(call.callee.name) : undefined
    if (call === undefined || unwrap === undefined || unwrap.renamed !== null)
      continue
    const mailer = call.arguments[0]
    if (call.arguments.length === 1 && mailer !== undefined) {
      editor.replace(call.start, call.end, code.slice(mailer.start, mailer.end))
      skipped.add(call.callee.start)
    }
    else if (mailer !== undefined) {
      reports.push([call.start, `register ${code.slice(mailer.start, mailer.end)} itself and move the options of ${unwrap.imported}(...) into its createMailer().`])
    }
  }
}

// Renames the specifiers of `stmt` and their uses; a name already taken keeps the old one as an alias, and an unused export that is gone is dropped.
function rewriteImport(code: string, stmt: Import, bindings: Map<string, Binding>, names: Set<string>, editor: SourceEditor, removedLines: number[]): void {
  let changed = false
  const specs: string[] = []
  for (const spec of stmt.specifiers) {
    const binding = spec.type === 'ImportSpecifier' ? bindings.get(spec.local.name) : undefined
    if (binding === undefined || binding.spec !== spec) {
      specs.push(code.slice(spec.start, spec.end))
      continue
    }
    changed = true
    const local = spec.local.name
    if (binding.renamed === null) {
      if (binding.refs.length > 0)
        specs.push(code.slice(spec.start, spec.end))
      continue
    }
    if (local !== binding.imported || binding.pinned || names.has(binding.renamed)) {
      specs.push(`${binding.renamed} as ${local}`)
      continue
    }
    specs.push(binding.renamed)
    for (const ref of binding.refs)
      editor.replace(ref.start, ref.end, binding.renamed)
  }
  if (!changed)
    return
  if (specs.length === 0) {
    const end = code[stmt.end] === '\n' ? stmt.end + 1 : stmt.end
    editor.remove(stmt.start, end)
    removedLines.push(stmt.start)
    return
  }
  const head = stmt.importKind === 'type' ? 'import type' : 'import'
  const quote = code[stmt.source.start]!
  const semi = code[stmt.end - 1] === ';' ? ';' : ''
  editor.replace(stmt.start, stmt.end, `${head} { ${specs.join(', ')} } from ${quote}${stmt.source.value}${quote}${semi}`)
}
