import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { keyName } from '../compiler/object-literal'
import { parseKay } from '../compiler/parser'
import { importedName, walk } from './ast'

const SOURCE_FILE = /(?:(?<!\.d)\.tsx?|\.kay)$/
const MAYBE_STEP_DRAFT = /\bstepDraft\b/
const UI_PACKAGE = '@kaynooo/kayjs-ui'
const UNITS = [['w', 604_800], ['d', 86_400], ['h', 3600], ['m', 60]] as const

// The `stepDraft(...)` calls of kayjs-ui whose options give `maxAge` as a number of seconds, the form before 1.73 took a duration. The number still works until 1.76.
// The project's own TypeScript files and the script and server fences of its components are read, the options only as an object literal at the call. The fix writes the longest whole unit, `3600` as `'1h'`, and is not offered for a number that is no positive integer.
export async function stepDraftMaxAge(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-step-draft-max-age', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!MAYBE_STEP_DRAFT.test(source))
      continue

    const parsed = file.endsWith('.kay') ? parseKay(source) : undefined
    const spans = parsed ? [parsed.script, parsed.server].filter(span => span !== undefined) : [{ start: 0, end: source.length }]

    for (const { start: base, end } of spans) {
      let ast: t.File

      try {
        ast = parse(source.slice(base, end), { sourceType: 'module', plugins: file.endsWith('.ts') ? ['typescript'] : ['typescript', 'jsx'], errorRecovery: true })
      }
      catch {
        continue
      }

      const local = importedStepDraft(ast)

      if (local === undefined)
        continue

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== local)
          return

        const argument = node.arguments[2]

        if (argument?.type !== 'ObjectExpression')
          return

        for (const property of argument.properties) {
          if (property.type !== 'ObjectProperty' || property.computed || keyName(property) !== 'maxAge')
            continue

          const value = property.value

          if (value.type !== 'NumericLiteral')
            continue

          const seconds = value.value

          const at = (offset: number) => base + offset

          found.push({
            file,
            ...positionAt(source, at(value.start!)),
            end: at(value.end!),
            message: '`maxAge` of `stepDraft` takes a duration since 1.73, not a number of seconds',
            help: `write \`'${durationText(seconds)}'\``,
            code: 'deprecated-step-draft-max-age',
            severity: level === 'warn' ? 'warning' : 'error',
            ...Number.isInteger(seconds) && seconds > 0 && { fixes: [{ title: 'Write maxAge as a duration', edits: [{ start: at(value.start!), end: at(value.end!), text: `'${durationText(seconds)}'` }], safe: true }] },
          })
        }
      })
    }
  }

  return found
}

function durationText(seconds: number): string {
  for (const [unit, length] of UNITS) {
    if (seconds % length === 0)
      return `${seconds / length}${unit}`
  }

  return `${seconds}s`
}

// The local name `stepDraft` is imported under from kayjs-ui, if it is.
function importedStepDraft(ast: t.File): string | undefined {
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || !statement.source.value.startsWith(UI_PACKAGE))
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && importedName(specifier) === 'stepDraft')
        return specifier.local.name
    }
  }

  return undefined
}
