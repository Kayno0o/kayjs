import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { basename, dirname, relative, resolve } from 'node:path'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { importsOf, walk } from './ast'
import { mask } from './renamed-names'

const SOURCE_FILE = /(?<!\.d)\.tsx?$/
const NAME_BREAK = /[^A-Z0-9]+/i
const LEADING_DOT = /^\./
const LEADING_DIGIT = /^\d/
const BACKSLASH = /\\/g

// `mountComponent('src/components/toggle.kay', props)` of `kay/test`: the string form, found in the project's TypeScript files, which takes the component imported in the file instead.
// The fix imports the component under its name in Pascal case and writes it in place of the path, unless the file already uses that name for something else.
export async function mountComponentPaths(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-mount-component', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!source.includes('mountComponent'))
      continue

    let ast: t.File

    try {
      ast = parse(source, { sourceType: 'module', plugins: file.endsWith('.ts') ? ['typescript'] : ['typescript', 'jsx'], errorRecovery: true })
    }
    catch {
      continue
    }

    const { locals, namespaces } = importsOf(ast, from => from === 'kay/test', 'mountComponent')
    // By the file a path names, so `./src/a.kay` and `src/a.kay` are one component.
    const calls = new Map<string, { path: string, literals: t.StringLiteral[] }>()

    if (locals.size === 0 && namespaces.size === 0)
      continue

    walk(ast, (node) => {
      if (node.type !== 'CallExpression')
        return

      const callee = node.callee
      const mounts = (callee.type === 'Identifier' && locals.has(callee.name)) || (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'mountComponent')
      const argument = node.arguments[0]

      if (mounts && argument?.type === 'StringLiteral' && argument.value.endsWith('.kay'))
        calls.set(resolve(root, argument.value), { path: argument.value, literals: [...calls.get(resolve(root, argument.value))?.literals ?? [], argument] })
    })

    const imports = ast.program.body.filter((statement): statement is t.ImportDeclaration => statement.type === 'ImportDeclaration')

    const code = mask(source)
    // The names this pass already gave an import: two files of one name cannot both be imported as it.
    const claimed = new Set<string>()

    for (const [target, { path, literals }] of calls) {
      const imported = imports.flatMap(statement => statement.importKind !== 'type' && resolve(dirname(file), statement.source.value) === target ? statement.specifiers.filter(specifier => specifier.type === 'ImportDefaultSpecifier') : [])[0]
      const name = imported?.local.name ?? componentName(path)
      const specifier = relative(dirname(file), target).replace(BACKSLASH, '/')
      const taken = imported === undefined && (claimed.has(name) || new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(code))

      claimed.add(name)
      const last = imports.at(-1)
      const edits = [
        ...literals.map(literal => ({ start: literal.start!, end: literal.end!, text: name })),
        ...imported === undefined && last !== undefined ? [{ start: last.end!, end: last.end!, text: `\nimport ${name} from '${LEADING_DOT.test(specifier) ? specifier : `./${specifier}`}'` }] : [],
      ]
      const first = literals[0]!

      found.push({
        file,
        ...positionAt(source, first.start!),
        end: first.end!,
        message: `\`mountComponent('${path}')\` takes the component itself since 1.70, which gives its props their types and a rename its uses`,
        help: `import the component and pass it: \`mountComponent(${name}, props)\``,
        code: 'deprecated-mount-component',
        severity: level === 'warn' ? 'warning' : 'error',
        ...!taken && { fixes: [{ title: `Mount ${name}`, edits, safe: true }] },
      })
    }
  }

  return found
}

function componentName(path: string): string {
  const name = basename(path, '.kay').split(NAME_BREAK).filter(Boolean).map(word => word[0]!.toUpperCase() + word.slice(1)).join('')

  return LEADING_DIGIT.test(name) ? `Component${name}` : name
}
