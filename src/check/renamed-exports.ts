import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'

// The exports a library renamed, whose old names it keeps as aliases for three minors: the lint goes with the alias, and a row with it.
const RENAMED: { module: string, from: string, to: string, since: string }[] = [
  { module: '@kaynooo/kayjs-cms', from: 'SaveConflict', to: 'SaveConflictError', since: '1.70' },
  { module: '@kaynooo/kayjs-mail', from: 'MailNotConfigured', to: 'MailNotConfiguredError', since: '1.70' },
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

// An import of a name a library renamed, in a `.kay` file or a script: the fix renames the specifier and every use of the name in the file, or imports the new name as the old one when a use cannot be told from a key or an exported name.
export async function renamedExports(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-renamed-export', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []
  const files = (await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })).filter(file => !DECLARATION_FILE.test(file))

  for (const file of files) {
    const source = await Bun.file(file).text()
    const imports = [...source.matchAll(IMPORT)]

    for (const { module, from, to } of RENAMED) {
      const own = imports.filter(statement => statement[3] === module)

      for (const statement of own) {
        const listStart = statement.index + statement[0].indexOf('{') + 1

        for (const specifier of statement[1]!.matchAll(SPECIFIER)) {
          if (specifier[1] !== from)
            continue

          const start = listStart + specifier.index + specifier[0].indexOf(from)
          const places = specifier[2] === undefined ? uses(file, source, from) : []
          const edits: Edit[] = places === undefined ? [{ start, end: start + from.length, text: `${to} as ${from}` }] : [{ start, end: start + from.length, text: to }, ...places.map(at => ({ start: at, end: at + from.length, text: to }))]

          found.push({
            file,
            ...positionAt(source, start),
            end: start + from.length,
            message: `\`${from}\` of ${module} is now \`${to}\`, every runtime error class ending in \`Error\`: the old name stays as an alias for three minors`,
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
