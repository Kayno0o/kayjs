import type { CheckDiagnostic, CheckOptions } from '.'
import { CSS_FILE, findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'

// The part classes kayjs-ui components stopped setting in 1.71 once their recipes drew the look in utilities, with the component and the part that replaces each. A slice of the move adds its components here; theme.css keeps the rules, and this table goes with them in 1.74.
export const REMOVED_UI_CLASSES: Record<string, { component: string, part: string }> = {
  'kui-card-head': { component: 'Card', part: 'head' },
  'kui-card-title': { component: 'Card', part: 'title' },
  'kui-card-body': { component: 'Card', part: 'body' },
  'kui-badge-icon': { component: 'Badge', part: 'icon' },
}

const KUI_CLASS = /\.(kui-[\w-]+)/g
const COMMENT = /\/\*[\s\S]*?\*\//g

// A stylesheet of the project selecting a part class a kayjs-ui component no longer sets. The rule still styles markup an app wrote by hand until 1.74, but never the component, so the report points at the `data-part` the part carries and at `src/ui.ts`. A selector has no safe rewrite, so there is no fix.
export async function removedUiClasses(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-ui-class', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, CSS_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!source.includes('kui-'))
      continue

    // Comments are blanked, not cut, so a position still points into the file.
    const code = source.replace(COMMENT, comment => comment.replace(/[^\n]/g, ' '))

    for (const match of code.matchAll(KUI_CLASS)) {
      const removed = REMOVED_UI_CLASSES[match[1]!]

      if (removed === undefined)
        continue

      found.push({
        file,
        ...positionAt(source, match.index),
        end: match.index + match[0].length,
        message: `\`.${match[1]}\` is no longer set on the \`${removed.part}\` of \`${removed.component}\` since 1.71, and its rule leaves theme.css in 1.74`,
        help: `select \`[data-part='${removed.part}']\` as a child of the component's root, or restyle the part from src/ui.ts: \`'@kaynooo/kayjs-ui/${removed.component.replace(/[A-Z]/g, (letter, at) => `${at > 0 ? '-' : ''}${letter.toLowerCase()}`)}.kay': { parts: { ${removed.part}: '...' } }\``,
        code: 'deprecated-ui-class',
        severity: level === 'warn' ? 'warning' : 'error',
      })
    }
  }

  return found
}
