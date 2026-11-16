import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { parseKay } from '../compiler/parser'
import { boundAt, proseSpans, templateScopes } from '../compiler/template-scopes'
import { walk } from './ast'
import { bindings, boundOnce } from './bindings'
import { scan } from './renamed-exports'

// What an action read before 1.105 on its own, which a form shows and now reads from `form`.
const READERS = ['failed', 'error', 'validate'] as const

const LOWERCASE = /^[a-z]/
const NEEDLE = /\.(?:failed|error|validate)\b/

function escaped(name: string): string {
  return name.replaceAll('$', '\\$')
}

function message(reader: string): string {
  return `an action's \`${reader}()\` is \`form.${reader}()\` since 1.105, the readers a form shows being grouped apart from the call state; the old name works until 1.108`
}

// The names a file binds once to an action: a call of `action` from `kay`, a `.with(...)` of one, or a lowercase name imported from a `.kay` file, where a page declares its actions, as `kay check` reads no types.
function actionNames(ast: Parameters<typeof bindings>[0]): Set<string> {
  const names = bindings(ast)
  const receivers = boundOnce(ast, names, 'action')

  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration' || typeof node.source.value !== 'string' || !node.source.value.endsWith('.kay'))
      continue

    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportSpecifier' && LOWERCASE.test(specifier.local.name) && names.get(specifier.local.name) === 1)
        receivers.add(specifier.local.name)
    }
  }

  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'CallExpression' && names.get(node.id.name) === 1) {
      const { callee } = node.init

      if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'with' && callee.object.type === 'Identifier' && receivers.has(callee.object.name))
        receivers.add(node.id.name)
    }
  })

  return receivers
}

// Whether a call of `reader` has the arguments the action's own has: none for `failed`, a field or none for `error`, a form and a field for `validate`.
function shaped(reader: string, args: Node[]): boolean {
  return reader === 'validate' ? args.length >= 1 && args.length <= 2 : args.length <= (reader === 'failed' ? 0 : 1)
}

// What an action reads since 1.105: `form.failed()`, `form.error(field)` and `form.validate(form, field)`, in place of `failed()`, `error(field)` and `validate(form, field)`, which the call state (`pending()`, `status()`, `data()`) no longer shares an object with.
// An action is known only by a name the file binds once to a call of `action` from `kay` or imports, lowercase, from a `.kay` file, as `kay check` reads no types; a template reads the names its fences bind. An action reached through a property or a prop is not found.
export async function actionReaders(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-action-readers', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-action-readers', NEEDLE, ({ file, parsed, source, report }) => {
    const receivers = new Set<string>()

    for (const { ast } of parsed) {
      for (const name of actionNames(ast))
        receivers.add(name)
    }

    if (receivers.size === 0)
      return

    for (const { ast, base } of parsed) {
      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        const { callee } = node

        if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier' || !receivers.has(callee.object.name))
          return

        const reader = callee.property.name

        if (!READERS.includes(reader as typeof READERS[number]) || !shaped(reader, node.arguments))
          return

        const at = base + callee.property.start

        report(at, base + callee.property.end, message(reader), `write \`form.${reader}()\``, [{ start: at, end: at, text: 'form.' }])
      })
    }

    // The template, outside the fences: the same reads written as text.
    const fences = parsed.map(({ base, text }) => [base, base + text.length] as const)
    const template = file.endsWith('.kay') ? parseKay(source) : undefined
    const scopes = template ? templateScopes(template) : []
    const prose = template ? proseSpans(template) : []
    const outside = (index: number, name: string) => !fences.some(([from, to]) => index >= from && index < to) && !prose.some(span => index >= span.start && index < span.end) && !boundAt(scopes, name, index)

    if (!template)
      return

    for (const name of receivers) {
      for (const match of source.matchAll(new RegExp(`(?<![\\w$.])${escaped(name)}\\.(${READERS.join('|')})\\(`, 'g'))) {
        if (!outside(match.index, name))
          continue

        const at = match.index + name.length + 1

        report(at, at + match[1]!.length, message(match[1]!), `write \`form.${match[1]!}()\``, [{ start: at, end: at, text: 'form.' }])
      }
    }
  })
}
