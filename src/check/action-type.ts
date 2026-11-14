import type { CheckDiagnostic, CheckOptions } from '.'
import { lintLevel } from '../compiler/lints'
import { importedName, walk } from './ast'
import { scan } from './renamed-exports'

const OLD_ARGUMENTS = /<\s*never\s*,\s*unknown\s*>/

// `Action<never, unknown>`, the type of an action of any input and output as before 1.105, is `Action` since: both parameters default to it, so the type a prop is given to take any action is the one every action has.
// Found on the `Action` a file imports from `kay`, under whatever local name, in the TypeScript files and the fences of `.kay` files.
export async function actionType(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-action-type', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-action-type', OLD_ARGUMENTS, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const locals = new Set<string>()

      for (const statement of ast.body) {
        if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay')
          continue

        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportSpecifier' && importedName(specifier) === 'Action')
            locals.add(specifier.local.name)
        }
      }

      if (locals.size === 0)
        continue

      walk(ast, (node) => {
        if (node.type !== 'TSTypeReference' || node.typeName.type !== 'Identifier' || !locals.has(node.typeName.name) || node.typeArguments === null || node.typeArguments === undefined)
          return

        const [input, output, ...rest] = node.typeArguments.params

        if (rest.length > 0 || input?.type !== 'TSNeverKeyword' || output?.type !== 'TSUnknownKeyword')
          return

        report(base + node.typeName.start, base + node.end, '`Action<never, unknown>` is `Action` since 1.105, which takes any action as a prop without the two parameters; the old form works until 1.108', 'write `Action`', [{ start: base + node.typeArguments.start, end: base + node.typeArguments.end, text: '' }])
      })
    }
  })
}
