import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'

// The exports kay or a library renamed, whose old names it keeps as aliases for three minors: the lint goes with the alias, and a row with it.
// `toModule` is where the new name is imported from when the entry moved too, and `why` ends the message when the rename has another reason than the error classes.
const RENAMED: { module: string, from: string, to: string, toModule?: string, why?: string }[] = [
  { module: '@kaynooo/kayjs-cms', from: 'SaveConflict', to: 'SaveConflictError' },
  { module: '@kaynooo/kayjs-mail', from: 'MailNotConfigured', to: 'MailNotConfiguredError' },
  { module: 'kay/dom', from: 'HydrationMismatch', to: 'HydrationMismatchError' },
  { module: 'kay', from: 'ActionRedirect', to: 'ActionRedirectError' },
  { module: 'kay/server', from: 'CspViolation', to: 'CspViolationError' },
  { module: 'kay/library', from: 'RedirectRefused', to: 'RedirectRefusedError' },
  { module: '@kaynooo/kayjs-cms/postgres', from: 'postgresLoader', to: 'pgLoader', toModule: '@kaynooo/kayjs-cms/pg', why: 'every kayjs library says pg, not postgres' },
  { module: '@kaynooo/kayjs-cms/postgres', from: 'PostgresLoaderOptions', to: 'PgLoaderOptions', toModule: '@kaynooo/kayjs-cms/pg', why: 'every kayjs library says pg, not postgres' },
  { module: '@kaynooo/kayjs-auth', from: 'memoryStore', to: 'memoryAuthStore', why: 'kay\'s `memoryStore` is the session one' },
  { module: '@kaynooo/kayjs-auth', from: 'Mailer', to: 'AuthMailer', why: 'kayjs-mail has a `Mailer` of its own' },
  { module: '@kaynooo/kayjs-auth', from: 'Mail', to: 'AuthMailMessage', why: 'kayjs-mail has a `Mail` of its own' },
  { module: '@kaynooo/kayjs-mail', from: 'Settings', to: 'MailSettings', why: 'kayjs-ui has a `Settings` of its own' },
  { module: '@kaynooo/kayjs-mail', from: 'defaults', to: 'mailDefaults', why: 'kayjs-ui has a `defaults` of its own' },
  { module: '@kaynooo/kayjs-mail', from: 'Field', to: 'MailField', why: 'kayjs-cms has a `Field` of its own' },
  { module: '@kaynooo/kayjs-mail', from: 'Message', to: 'MailMessage', why: 'kayjs-ai has a `Message` of its own' },
  { module: '@kaynooo/kayjs-ui', from: 'Settings', to: 'UiSettings', why: 'kayjs-mail has a `Settings` of its own' },
  { module: '@kaynooo/kayjs-ui', from: 'defaults', to: 'uiDefaults', why: 'kayjs-mail has a `defaults` of its own' },
]

const SOURCE_FILE = /\.(?:kay|[cm]?tsx?)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g
const SPECIFIER = /(?<![\w$])(?:type\s+)?([\w$]+)(\s+as\s+[\w$]+)?/g

interface Edit {
  start: number
  end: number
  text: string
}

// The places a script uses `name` as a binding, or undefined when one cannot be told from a key or an exported name (a shorthand property, a re-export), or the file is no script babel parses.
function uses(file: string, source: string, name: string): number[] | undefined {
  if (file.endsWith('.kay'))
    return undefined

  let ast: t.File

  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  }
  catch {
    return undefined
  }

  const found: number[] = []
  let ambiguous = false
  const visit = (node: t.Node, parent: t.Node | undefined): void => {
    if (node.type === 'ImportDeclaration')
      return

    if (node.type === 'Identifier' && node.name === name) {
      const isKey = parent !== undefined && ('key' in parent && parent.key === node && !('computed' in parent && parent.computed === true))
      const isMember = parent !== undefined && (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.property === node && !parent.computed
      const isShorthand = parent?.type === 'ObjectProperty' && parent.shorthand
      const isQualified = parent?.type === 'TSQualifiedName' && parent.right === node

      if (isShorthand || parent?.type === 'ExportSpecifier')
        ambiguous = true
      else if (!isKey && !isMember && !isQualified)
        found.push(node.start!)
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key.endsWith('Comments'))
        continue

      for (const child of Array.isArray(value) ? value : [value]) {
        if (child !== null && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string')
          visit(child as t.Node, node)
      }
    }
  }

  visit(ast, undefined)

  return ambiguous ? undefined : found
}

// The edits renaming one imported specifier, and its uses in the file when it is not aliased.
function editsOf(file: string, source: string, listStart: number, specifier: RegExpMatchArray, from: string, to: string): Edit[] {
  const start = listStart + specifier.index! + specifier[0].indexOf(from)
  const places = specifier[2] === undefined ? uses(file, source, from) : []

  return places === undefined ? [{ start, end: start + from.length, text: `${to} as ${from}` }] : [{ start, end: start + from.length, text: to }, ...places.map(at => ({ start: at, end: at + from.length, text: to }))]
}

// An import of a name a library renamed, in a `.kay` file or a script: the fix renames the specifier and every use of the name in the file, or imports the new name as the old one when a use cannot be told from a key or an exported name.
export async function renamedExports(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-renamed-export', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []
  const files = (await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })).filter(file => !DECLARATION_FILE.test(file))

  for (const file of files) {
    const source = await Bun.file(file).text()

    if (!RENAMED.some(({ module }) => source.includes(module)))
      continue

    const imports = [...source.matchAll(IMPORT)]

    for (const { module, from, to, toModule, why } of RENAMED) {
      const own = imports.filter(statement => statement[3] === module)

      for (const statement of own) {
        const listStart = statement.index + statement[0].indexOf('{') + 1

        for (const specifier of statement[1]!.matchAll(SPECIFIER)) {
          if (specifier[1] !== from)
            continue

          const start = listStart + specifier.index + specifier[0].indexOf(from)
          const edits = editsOf(file, source, listStart, specifier, from, to)

          // An entry that moved takes every name the statement imports from it along, as the old entry no longer has the new names.
          if (toModule !== undefined) {
            const at = statement.index + statement[0].lastIndexOf(module)

            for (const sibling of RENAMED.filter(other => other.module === module && other.toModule === toModule && other.from !== from)) {
              for (const other of statement[1]!.matchAll(SPECIFIER)) {
                if (other[1] === sibling.from)
                  edits.push(...editsOf(file, source, listStart, other, sibling.from, sibling.to))
              }
            }

            edits.push({ start: at, end: at + module.length, text: toModule })
          }

          found.push({
            file,
            ...positionAt(source, start),
            end: start + from.length,
            message: `\`${from}\` of ${module} is now \`${to}\`${toModule === undefined ? '' : ` of ${toModule}`}, ${why ?? 'every runtime error class ending in Error'}: the old name stays as an alias for three minors`,
            help: `import \`${to}\``,
            code: 'deprecated-renamed-export',
            severity: level === 'warn' ? 'warning' : 'error',
            fixes: [{ title: `Rename ${from} to ${to}`, edits, safe: true }],
          })
        }
      }
    }
  }

  return found
}
