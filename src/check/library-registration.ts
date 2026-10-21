import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from '@babel/parser'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { CONFIG_FILE } from '../config'
import { walk } from './ast'

interface Edit {
  start: number
  end: number
  text: string
}

// What each old registration is called, the library it comes from, and what it is called now.
const OLD_FORMS = [
  { library: '@kaynooo/kayjs-auth', old: 'authPages', now: 'auth' },
  { library: '@kaynooo/kayjs-auth', old: 'authExtension', now: 'auth' },
  { library: '@kaynooo/kayjs-mail', old: 'mailExtension', now: 'mail' },
] as const

type OldForm = typeof OLD_FORMS[number]

// An import specifier holds its name twice, as `imported` and as `local`.
const IMPORT_NODES = 2

interface Found {
  form: OldForm
  call: t.CallExpression
  // The rewritten call, else why it has none.
  rewrite: string | undefined
}

function keyOf(property: t.ObjectProperty): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'StringLiteral' ? property.key.value : undefined
}

// The path of `() => import('./src/auth')`, async or not.
function importedPath(node: t.Node | null | undefined): string | undefined {
  if (node?.type !== 'ArrowFunctionExpression' || node.params.length > 0)
    return undefined

  const body = node.body

  if (body.type !== 'CallExpression' || body.callee.type !== 'Import' || body.arguments.length !== 1)
    return undefined

  const [specifier] = body.arguments

  return specifier?.type === 'StringLiteral' ? specifier.value : undefined
}

const NAMED_AUTH = /export\s+(?:const|let|var)\s+auth\b|export\s*\{[^}]*\bauth\b/

// Whether the module at `path` exports `auth` by name, which `auth({ module })` reads and the old forms read beside a default export.
function exportsAuth(root: string, path: string): boolean {
  try {
    return NAMED_AUTH.test(readFileSync(Bun.resolveSync(resolve(root, path), root), 'utf8'))
  }
  catch {
    return false
  }
}

function literal(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

// The call written the new way, or undefined where the old one carries something the new cannot take as written, such as a module that exports its `auth` as the default alone.
function rewritten(form: OldForm, call: t.CallExpression, source: string, root: string): string | undefined {
  const [first, ...rest] = call.arguments
  const text = (node: t.Node) => source.slice(node.start!, node.end!)

  if (rest.length > 0)
    return undefined

  if (form.old === 'mailExtension')
    return first?.type === 'StringLiteral' ? `mail({ module: ${text(first)} })` : undefined

  if (form.old === 'authExtension') {
    const path = importedPath(first)

    return path === undefined || !exportsAuth(root, path) ? undefined : `auth({ module: ${literal(path)}, pages: false })`
  }

  if (first === undefined)
    return 'auth()'

  if (first.type !== 'ObjectExpression')
    return undefined

  const members: string[] = []

  for (const property of first.properties) {
    if (property.type === 'SpreadElement') {
      members.push(text(property))

      continue
    }

    if (property.type !== 'ObjectProperty') {
      members.push(text(property))

      continue
    }

    const path = keyOf(property) === 'auth' ? importedPath(property.value) : undefined

    if (keyOf(property) === 'auth' && (path === undefined || !exportsAuth(root, path)))
      return undefined

    members.push(path === undefined ? text(property) : `module: ${literal(path)}`)
  }

  return members.length === 0 ? 'auth()' : `auth({ ${members.join(', ')} })`
}

// The registrations an app's `kay.config.ts` still writes the old way: `authPages({ auth: () => import('./src/auth') })` and `authExtension(...)` for kayjs-auth, `mailExtension('./src/mail')` for kayjs-mail.
export function oldRegistrations(root: string, options: CheckOptions): CheckDiagnostic[] {
  const level = lintLevel('deprecated-library-registration', options.lints)

  if (level === 'allow')
    return []

  const file = join(root, CONFIG_FILE)
  let source: string
  let ast: t.File

  try {
    source = readFileSync(file, 'utf8')
    ast = parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
  }
  catch {
    return []
  }

  const imports: { form: OldForm, specifier: t.ImportSpecifier, declaration: t.ImportDeclaration }[] = []

  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type')
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type')
        continue

      const name = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
      const form = OLD_FORMS.find(candidate => candidate.old === name && candidate.library === statement.source.value)

      if (form !== undefined && specifier.local.name === name)
        imports.push({ form, specifier, declaration: statement })
    }
  }

  if (imports.length === 0)
    return []

  const found: Found[] = []
  // Every use of an old name that is not the import: all must be a call this rewrites, else the import stays and so do the calls.
  const uses = new Map<string, number>()
  const names = new Set(imports.map(({ form }) => form.old))
  // Names the new forms would take that the file already binds or reads.
  const taken = new Set<string>()
  const wanted = new Set(imports.map(({ form }) => form.now))

  // The names that are keys or members, not bindings or reads.
  const labels = new WeakSet<t.Node>()

  walk(ast, (node) => {
    if ((node.type === 'ObjectProperty' || node.type === 'ObjectMethod') && !node.computed)
      labels.add(node.key)

    if (node.type === 'MemberExpression' && !node.computed)
      labels.add(node.property)

    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && names.has(node.callee.name as never)) {
      const form = imports.find(({ form: candidate }) => candidate.old === (node.callee as t.Identifier).name)!.form

      found.push({ form, call: node, rewrite: rewritten(form, node, source, root) })
    }

    if (node.type === 'Identifier' && !labels.has(node)) {
      if (names.has(node.name as never))
        uses.set(node.name, (uses.get(node.name) ?? 0) + 1)

      if (wanted.has(node.name as never))
        taken.add(node.name)
    }
  })

  if (found.length === 0)
    return []

  const severity = level === 'warn' ? 'warning' : 'error'
  // An old name is fixed only where its import and every use go together.
  const fixable = new Set(OLD_FORMS.map(form => form.old).filter(name => names.has(name) && found.filter(({ form }) => form.old === name).every(({ rewrite, form }) => rewrite !== undefined && !taken.has(form.now)) && uses.get(name) === found.filter(({ form }) => form.old === name).length + IMPORT_NODES))
  // One fix holds every edit of the file, so applying one problem's fix leaves no import without the name a call still uses.
  const edits: Edit[] = [...found.filter(({ form }) => fixable.has(form.old)).map(({ call, rewrite }) => ({ start: call.start!, end: call.end!, text: rewrite! })), ...importRewrites(source, imports.filter(({ form }) => fixable.has(form.old)))]
  const diagnostics: CheckDiagnostic[] = []

  for (const { form, call } of found) {
    const callee = call.callee as t.Identifier

    diagnostics.push({
      file,
      ...positionAt(source, callee.start!),
      end: callee.end!,
      message: `\`${form.old}\` is the old way to register ${form.library}, which every library now registers with \`x({ module })\``,
      help: `use \`${form.now}({ module: './src/${form.now}'${form.old === 'authExtension' ? ', pages: false' : ''} })\``,
      code: 'deprecated-library-registration',
      severity,
      ...fixable.has(form.old) && { fixes: [{ title: `Use ${form.now}({ module })`, edits, safe: true }] },
    })
  }

  return diagnostics
}

// The import lines with the old names replaced by the new ones, a name both old forms give written once.
function importRewrites(source: string, fixed: { form: OldForm, specifier: t.ImportSpecifier, declaration: t.ImportDeclaration }[]): Edit[] {
  return [...new Set(fixed.map(entry => entry.declaration))].map((declaration) => {
    const names = declaration.specifiers.map((specifier) => {
      const entry = fixed.find(candidate => candidate.specifier === specifier)

      return entry === undefined ? source.slice(specifier.start!, specifier.end!) : entry.form.now
    })

    return { start: declaration.specifiers[0]!.start!, end: declaration.specifiers.at(-1)!.end!, text: [...new Set(names)].join(', ') }
  })
}
