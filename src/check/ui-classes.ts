import type { CheckDiagnostic, CheckOptions } from '.'
import { CSS_FILE, findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'

// The part classes kayjs-ui components stopped setting once their recipes drew the look in utilities, with the component, the part that replaces each and the minor that dropped it. A slice of the move adds its components here; theme.css keeps the rules, and this table goes with them in 1.74.
export const REMOVED_UI_CLASSES: Record<string, { component: string, part: string, since: string }> = {
  'kui-card-head': { component: 'Card', part: 'head', since: '1.71' },
  'kui-card-title': { component: 'Card', part: 'title', since: '1.71' },
  'kui-card-body': { component: 'Card', part: 'body', since: '1.71' },
  'kui-badge-icon': { component: 'Badge', part: 'icon', since: '1.71' },
  'kui-avatar-image': { component: 'Avatar', part: 'image', since: '1.72' },
  'kui-avatar-initial': { component: 'Avatar', part: 'initial', since: '1.72' },
  'kui-stat-value': { component: 'Stat', part: 'value', since: '1.72' },
  'kui-stat-label': { component: 'Stat', part: 'label', since: '1.72' },
  'kui-page-header-head': { component: 'PageHeader', part: 'head', since: '1.72' },
  'kui-page-header-title': { component: 'PageHeader', part: 'title', since: '1.72' },
  'kui-page-header-meta': { component: 'PageHeader', part: 'meta', since: '1.72' },
  'kui-page-header-actions': { component: 'PageHeader', part: 'actions', since: '1.72' },
  'kui-page-header-description': { component: 'PageHeader', part: 'description', since: '1.72' },
  'kui-page-section-head': { component: 'PageSection', part: 'head', since: '1.72' },
  'kui-page-section-title': { component: 'PageSection', part: 'title', since: '1.72' },
  'kui-empty-state-title': { component: 'EmptyState', part: 'title', since: '1.72' },
  'kui-empty-state-description': { component: 'EmptyState', part: 'description', since: '1.72' },
  'kui-empty-state-actions': { component: 'EmptyState', part: 'actions', since: '1.72' },
  'kui-card-row-body': { component: 'CardRow', part: 'body', since: '1.72' },
  'kui-card-row-actions': { component: 'CardRow', part: 'actions', since: '1.72' },
  'kui-widget-head': { component: 'Widget', part: 'head', since: '1.72' },
  'kui-widget-title': { component: 'Widget', part: 'title', since: '1.72' },
  'kui-meter-fill': { component: 'Meter', part: 'fill', since: '1.72' },
  'kui-progress-fill': { component: 'Progress', part: 'fill', since: '1.72' },
  'kui-skeleton-block': { component: 'Skeleton', part: 'block', since: '1.72' },
  'kui-skeleton-label': { component: 'Skeleton', part: 'label', since: '1.72' },
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
        message: `\`.${match[1]}\` is no longer set on the \`${removed.part}\` of \`${removed.component}\` since ${removed.since}, and its rule leaves theme.css in 1.74`,
        help: `select \`[data-part='${removed.part}']\` under the component's root (with \`>\` where the part is a direct child, so a nested component's part is left alone), or restyle the part from src/ui.ts: \`'@kaynooo/kayjs-ui/${removed.component.replace(/[A-Z]/g, (letter, at) => `${at > 0 ? '-' : ''}${letter.toLowerCase()}`)}.kay': { parts: { ${removed.part}: '...' } }\``,
        code: 'deprecated-ui-class',
        severity: level === 'warn' ? 'warning' : 'error',
      })
    }
  }

  return found
}
