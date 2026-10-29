import type { CallExpression, ImportDeclaration, ImportSpecifier } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { NodeOfType } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { importedName, walk } from './ast'
import { mentions, scan } from './renamed-exports'

const AUTH_PACKAGE = '@kaynooo/kayjs-auth'
const NEWLINE = /^\r?\n/
const SAFE_REDIRECT = /\bsafeRedirect\b/

// `safeRedirect(path, fallback?)` of kayjs-auth, kay's `localPath(path, fallback)` with `/` as the default: the fix calls `localPath` and imports it from kay.
export async function safeRedirects(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-safe-redirect', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-safe-redirect', SAFE_REDIRECT, ({ file, parsed, unparsed, report }) => {
    for (const { ast, base, text } of parsed) {
      const imports = ast.body.filter((statement): statement is ImportDeclaration => statement.type === 'ImportDeclaration' && statement.importKind !== 'type')
      const library = imports.filter(statement => statement.source.value === AUTH_PACKAGE)
      const specifier = library.flatMap(statement => statement.specifiers).find((one): one is ImportSpecifier => one.type === 'ImportSpecifier' && one.importKind !== 'type' && importedName(one) === 'safeRedirect')

      const namespaces = new Set(library.flatMap(statement => statement.specifiers).flatMap(one => one.type === 'ImportNamespaceSpecifier' ? [one.local.name] : []))

      walk(ast, (node) => {
        if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && namespaces.has(node.object.name) && node.property.type === 'Identifier' && node.property.name === 'safeRedirect')
          report(base + node.property.start, base + node.property.end, '`safeRedirect` is kay\'s `localPath` under another name: kayjs-auth keeps it until 1.87', 'call `localPath(path, \'/\')` from kay', null)
      })

      if (!specifier)
        continue

      const local = specifier.local.name
      const declaration = library.find(statement => statement.specifiers.includes(specifier))!
      const kay = imports.find(statement => statement.source.value === 'kay' && statement.specifiers.some(one => one.type === 'ImportSpecifier' && one.importKind !== 'type' && importedName(one) === 'localPath' && one.local.name === 'localPath'))
      const calls: CallExpression[] = []
      let others = 0

      for (const statement of ast.body) {
        if (statement.type === 'ImportDeclaration')
          continue

        walk(statement, (node) => {
          if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === local && node.arguments.length >= 1 && node.arguments.length <= 2 && node.arguments.every(argument => argument.type !== 'SpreadElement'))
            calls.push(node)
          else if (node.type === 'Identifier' && node.name === local)
            others++
        })
      }

      // Each call has its callee as one read of the name; any other read is the function used as a value, which no call rewrite covers.
      // A template, another span or a file where `localPath` is already some other name is left to the app.
      const elsewhere = SAFE_REDIRECT.test(unparsed) || parsed.some(other => other.text !== text && SAFE_REDIRECT.test(other.text))
      const taken = !kay && mentions(parsed.map(one => one.ast), 'localPath')
      const rewritable = !elsewhere && !taken && others === calls.length && calls.every(call => call.arguments.length === 1 || (call.arguments[1]!.type === 'Literal' && typeof call.arguments[1]!.value === 'string'))
      // A fence needs no import of `localPath`, which the compiler adds when it reads it.
      const importEdits = rewritable ? [dropSpecifier(declaration, specifier, text), ...kay || file.endsWith('.kay') ? [] : [{ start: declaration.start, end: declaration.start, text: 'import { localPath } from \'kay\'\n' }]] : []

      for (const [index, call] of calls.entries()) {
        const callee = call.callee as NodeOfType<'Identifier'>
        const edits = !rewritable ? [] : [{ start: callee.start, end: callee.end, text: 'localPath' }, ...call.arguments.length === 1 ? [{ start: call.arguments[0]!.end, end: call.arguments[0]!.end, text: ', \'/\'' }] : [], ...index === 0 ? importEdits : []].map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end }))

        report(base + callee.start, base + callee.end, '`safeRedirect` is kay\'s `localPath` under another name: kayjs-auth keeps it until 1.87', 'call `localPath(path, \'/\')` from kay', edits)
      }
    }
  })
}

// The specifier out of its import, the whole import when it was alone.
function dropSpecifier(declaration: ImportDeclaration, specifier: ImportSpecifier, text: string): Edit {
  if (declaration.specifiers.length === 1)
    return { start: declaration.start, end: declaration.end + (NEWLINE.exec(text.slice(declaration.end))?.[0].length ?? 0), text: '' }

  const index = declaration.specifiers.indexOf(specifier)
  const next = declaration.specifiers[index + 1]

  return next ? { start: specifier.start, end: next.start, text: '' } : { start: declaration.specifiers[index - 1]!.end, end: specifier.end, text: '' }
}
