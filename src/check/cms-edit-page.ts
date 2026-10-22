import type { CheckDiagnostic, CheckOptions } from '.'
import type { Attribute } from '../compiler/ast'
import { findProjectFiles } from '../build/files'
import { elementsIn } from '../compiler/ast'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'

const KAY_ONLY = /\.kay$/
const OLD = 'data-cms-edit-page'
const NEW = 'data-kcms-edit-page'

// The attribute of a link kayjs-cms fills in, written `data-cms-edit-page` before 1.70, as a library's data attributes are `data-k<library>-`.
// The module still matches the old name for three minors.
export async function renamedCmsEditPage(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-cms-edit-page', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, KAY_ONLY, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!source.includes(OLD))
      continue

    const parsed = parseKay(source)
    const levelAt = lintLevels(source, options.lints)

    for (const element of elementsIn(parsed.template)) {
      const named = (name: string) => element.attributes.filter((attribute): attribute is Exclude<Attribute, { kind: 'spread' }> => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === name)

      for (const attribute of named(OLD)) {
        const here = levelAt('deprecated-cms-edit-page', attribute.name.start)

        if (here === 'allow')
          continue

        found.push({
          file,
          ...positionAt(source, attribute.name.start),
          end: attribute.name.end,
          message: `\`${OLD}\` is \`${NEW}\` since 1.70, as a library's data attributes are \`data-k<library>-\``,
          help: `write \`${NEW}\` for \`${OLD}\``,
          code: 'deprecated-cms-edit-page',
          severity: here === 'warn' ? 'warning' : 'error',
          ...named(NEW).length === 0 && { fixes: [{ title: `Use ${NEW}`, edits: [{ start: attribute.name.start, end: attribute.name.end, text: NEW }], safe: true }] },
        })
      }
    }
  }

  return found
}
