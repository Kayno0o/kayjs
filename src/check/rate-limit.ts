import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { importedName, walk } from './ast'
import { keyOf } from './retired-lint'

const SOURCE_FILE = /(?:(?<!\.d)\.tsx?|\.kay)$/
const AI_PACKAGE = '@kaynooo/kayjs-ai'
const AUTH_PACKAGE = '@kaynooo/kayjs-auth'
const MAIL_PACKAGE = '@kaynooo/kayjs-mail'

// Where the options object of a call sits among its arguments, and the old name of each option it renames.
interface Site {
  at: number
  renames: Record<string, string>
  // A number literal under this key is mails a second, the old form of `{ max, window: '1s' }`, found in the object under `inside` when it is set.
  count?: string
  inside?: string
}

const AI_OPTIONS: Site = { at: 0, renames: { limit: 'rateLimit', visitor: 'key' } }
const ASK_OPTIONS: Site = { at: 1, renames: { visitor: 'key' } }
const AUTH_OPTIONS: Site = { at: 0, renames: { limits: 'rateLimit' } }

const SMTP_OPTIONS: Site = { at: 0, renames: {}, count: 'rateLimit' }
const MAILER_OPTIONS: Site = { at: 0, renames: {}, count: 'rateLimit', inside: 'smtp' }

const FUNCTIONS: Record<string, Record<string, Site>> = {
  [AI_PACKAGE]: { ai: AI_OPTIONS, ask: ASK_OPTIONS },
  [AUTH_PACKAGE]: { createAuth: AUTH_OPTIONS },
  [MAIL_PACKAGE]: { smtp: SMTP_OPTIONS, mailer: MAILER_OPTIONS },
}

// The options `ai({ limit, visitor })`, `ask(messages, { visitor })` and `createAuth({ limits })` took before 1.70 named `rateLimit` and `key`, as the other rate limits of kay are, and the number of mails a second of `smtp({ rateLimit })` and `mailer({ smtp: { rateLimit } })`, as an object literal at the call is written.
// The project's own TypeScript files and the script and server fences of its components are read, and only the calls of a name imported from the library; an object held in a variable is not read.
export async function rateLimitNames(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-rate-limit', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!source.includes('@kaynooo/kayjs-'))
      continue

    const parsed = file.endsWith('.kay') ? parseKay(source) : undefined
    const spans = parsed ? [parsed.script, parsed.server, parsed.module].filter(span => span !== undefined) : [{ start: 0, end: source.length }]

    for (const { start: base, end } of spans) {
      const code = source.slice(base, end)
      let ast: t.File

      try {
        ast = parse(code, { sourceType: 'module', plugins: file.endsWith('.ts') ? ['typescript'] : ['typescript', 'jsx'], errorRecovery: true })
      }
      catch {
        continue
      }

      const locals = new Map<string, Site>()
      const namespaces = new Map<string, Record<string, Site>>()

      for (const statement of ast.program.body) {
        const functions = statement.type === 'ImportDeclaration' ? FUNCTIONS[statement.source.value] : undefined

        if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || functions === undefined)
          continue

        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') {
            namespaces.set(specifier.local.name, functions)
          }
          else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && functions[importedName(specifier)]) {
            locals.set(specifier.local.name, functions[importedName(specifier)]!)
          }
        }
      }

      if (locals.size === 0 && namespaces.size === 0)
        continue

      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        const callee = node.callee
        let site: Site | undefined

        if (callee.type === 'Identifier')
          site = locals.get(callee.name)
        else if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier')
          site = namespaces.get(callee.object.name)?.[callee.property.name]

        const argument = site === undefined ? undefined : node.arguments[site.at]

        if (site === undefined || argument?.type !== 'ObjectExpression')
          return

        const nested = site.inside === undefined ? undefined : argument.properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && keyOf(property) === site.inside)?.value
        const target = site.inside === undefined ? argument : nested
        const properties = (target?.type === 'ObjectExpression' ? target.properties : []).filter((property): property is t.ObjectProperty => property.type === 'ObjectProperty')

        for (const property of properties) {
          if (site.count === undefined || keyOf(property) !== site.count || property.value.type !== 'NumericLiteral' || !Number.isInteger(property.value.value) || property.value.value < 1)
            continue

          const value = property.value
          const text = String(value.extra?.raw ?? value.value)

          found.push({
            file,
            ...positionAt(source, base + value.start!),
            end: base + value.end!,
            message: `${text} mails a second is \`{ max: ${text}, window: '1s' }\` since 1.70, as every rate limit of kay is written`,
            help: `write \`{ max: ${text}, window: '1s' }\``,
            code: 'deprecated-rate-limit',
            severity: level === 'warn' ? 'warning' : 'error',
            fixes: [{ title: 'Use max and window', edits: [{ start: base + value.start!, end: base + value.end!, text: `{ max: ${text}, window: '1s' }` }], safe: true }],
          })
        }

        for (const property of properties) {
          const old = keyOf(property)
          const renamed = old === undefined ? undefined : site.renames[old]

          if (old === undefined || renamed === undefined)
            continue

          // The new name beside the old one: the new wins already, and renaming would repeat a key.
          const taken = properties.some(other => keyOf(other) === renamed)
          const at = base + property.key.start!

          found.push({
            file,
            ...positionAt(source, at),
            end: base + property.key.end!,
            message: `\`${old}\` is \`${renamed}\` since 1.70, as every rate limit of kay is named`,
            help: `rename \`${old}\` to \`${renamed}\``,
            code: 'deprecated-rate-limit',
            severity: level === 'warn' ? 'warning' : 'error',
            ...!taken && { fixes: [{ title: `Use ${renamed}`, edits: [{ start: at, end: property.shorthand ? base + property.end! : base + property.key.end!, text: property.shorthand ? `${renamed}: ${old}` : renamed }], safe: true }] },
          })
        }
      })
    }
  }

  return found
}
