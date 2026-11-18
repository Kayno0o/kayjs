import type { CheckDiagnostic, CheckOptions } from '.'
import type { LintName } from '../compiler/lints'
import type { Property } from './regroup'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { configObjects } from './config-objects'
import { nameOf, regrouped } from './regroup'
import { scan } from './renamed-exports'

export interface MovedKeys {
  lint: LintName
  // Finds the files worth parsing.
  needle: RegExp
  // The group a top-level key of the config moved into, if it did.
  group: (name: string) => string | undefined
  help: string
}

// The keys of the config that moved into a group of their own, under their own names, as `client: { search }`.
// The fix, from the first report of an object, moves them into the group as written, and offers none where the object spreads, holds a computed key, or has the group already.
export async function movedKeys(root: string, options: CheckOptions, { lint, needle, group, help }: MovedKeys): Promise<CheckDiagnostic[]> {
  if (lintLevel(lint, options.lints) === 'allow')
    return []

  const movedTo = (name: string): [string, string] | undefined => {
    const target = group(name)

    return target === undefined ? undefined : [target, name]
  }

  return scan(root, options, lint, needle, ({ file, parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      for (const { object, call } of configObjects(file, ast)) {
        // The options of a call are written in `config`.
        if (call !== undefined)
          continue

        const old = object.properties.filter((property): property is Property => property.type === 'Property' && !property.computed && movedTo(nameOf(property)) !== undefined)
        const fixed = old.length === 0 ? undefined : regrouped(object, text, movedTo, true)

        for (const [index, property] of old.entries()) {
          const edits: Edit[] | null = index === 0 && fixed !== undefined ? fixed.map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end })) : null

          report(base + property.start, base + property.end, `\`${nameOf(property)}\` of the config is \`${group(nameOf(property))}.${nameOf(property)}\` since 1.105`, help, edits)
        }
      }
    }
  })
}
