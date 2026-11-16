import type { CheckDiagnostic, CheckOptions } from '.'
import type { Edit } from './renamed-exports'
import { basename } from 'node:path'
import { RETIRED_LINTS } from '../compiler/deprecated-allow'
import { lintLevel } from '../compiler/lints'
import { constBindings, exportedObject, keyName } from '../compiler/object-literal'
import { scan } from './renamed-exports'

const NEEDLE = /uncaught-await/

// A `lints: { 'uncaught-await': ... }` entry in kay.config.ts: the lint is gone since 1.105, so the entry sets nothing. The fix deletes the entry with its line.
export async function retiredLintLevels(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-uncaught-await', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-uncaught-await', NEEDLE, ({ file, parsed, report }) => {
    if (basename(file) !== 'kay.config.ts')
      return

    for (const { ast, base, text } of parsed) {
      const lints = exportedObject(ast, constBindings(ast))?.properties.find(property => property.type === 'Property' && !property.computed && keyName(property) === 'lints')

      if (lints?.type !== 'Property' || lints.value.type !== 'ObjectExpression')
        continue

      for (const property of lints.value.properties) {
        const name = property.type === 'Property' && !property.computed ? keyName(property) : undefined

        if (property.type !== 'Property' || name === undefined || !RETIRED_LINTS.has(name))
          continue

        // The entry with its comma, and the line it leaves empty.
        let start = property.start
        let end = property.end

        while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t'))
          start--

        if (text[end] === ',')
          end++

        const alone = (start === 0 || text[start - 1] === '\n') && text[end] === '\n'
        const edits: Edit[] = [{ start: base + start, end: base + (alone ? end + 1 : end), text: '' }]

        report(base + property.start, base + property.end, `\`lints\` names \`${name}\`, a lint that is gone since 1.105`, 'an `await` with no `catch` renders an alert, so there is nothing to set: remove the entry', edits)
      }
    }
  })
}
