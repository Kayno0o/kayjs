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
  // Tables and navigation (slice 5).
  'kui-table': { component: 'Table', part: 'table', since: '1.72' },
  'kui-table-filter': { component: 'Table', part: 'filter', since: '1.72' },
  'kui-table-filter-input': { component: 'Table', part: 'filterInput', since: '1.72' },
  'kui-table-count': { component: 'Table', part: 'count', since: '1.72' },
  'kui-table-selection': { component: 'Table', part: 'selection', since: '1.72' },
  'kui-table-selected': { component: 'Table', part: 'selected', since: '1.72' },
  'kui-table-bulk': { component: 'Table', part: 'bulk', since: '1.72' },
  'kui-table-head-cell': { component: 'Table', part: 'headCell', since: '1.72' },
  'kui-table-select-cell': { component: 'Table', part: 'selectCell', since: '1.72' },
  'kui-table-select-text': { component: 'Table', part: 'selectText', since: '1.72' },
  'kui-table-sort-btn': { component: 'Table', part: 'sortButton', since: '1.72' },
  'kui-table-sort-icon': { component: 'Table', part: 'sortIcon', since: '1.72' },
  'kui-table-row': { component: 'Table', part: 'row', since: '1.72' },
  'kui-table-cell': { component: 'Table', part: 'cell', since: '1.72' },
  'kui-table-cell-label': { component: 'Table', part: 'cellLabel', since: '1.72' },
  'kui-table-cell-body': { component: 'Table', part: 'cellBody', since: '1.72' },
  'kui-table-empty-cell': { component: 'Table', part: 'emptyCell', since: '1.72' },
  'kui-tabs-list': { component: 'Tabs', part: 'list', since: '1.72' },
  'kui-tabs-tab': { component: 'Tabs', part: 'tab', since: '1.72' },
  'kui-tabs-icon': { component: 'Tabs', part: 'icon', since: '1.72' },
  'kui-tabs-panel': { component: 'Tabs', part: 'panel', since: '1.72' },
  'kui-tab-nav-link': { component: 'TabNav', part: 'link', since: '1.72' },
  'kui-breadcrumb-list': { component: 'Breadcrumb', part: 'list', since: '1.72' },
  'kui-breadcrumb-more': { component: 'Breadcrumb', part: 'more', since: '1.72' },
  'kui-breadcrumb-item': { component: 'Breadcrumb', part: 'item', since: '1.72' },
  'kui-breadcrumb-link': { component: 'Breadcrumb', part: 'link', since: '1.72' },
  'kui-breadcrumb-text': { component: 'Breadcrumb', part: 'text', since: '1.72' },
  'kui-pagination-step': { component: 'Pagination', part: 'step', since: '1.72' },
  'kui-pagination-gap': { component: 'Pagination', part: 'gap', since: '1.72' },
  'kui-pagination-page': { component: 'Pagination', part: 'page', since: '1.72' },
  'kui-steps-list': { component: 'Steps', part: 'list', since: '1.72' },
  'kui-steps-item': { component: 'Steps', part: 'item', since: '1.72' },
  'kui-steps-link': { component: 'Steps', part: 'link', since: '1.72' },
  'kui-steps-marker': { component: 'Steps', part: 'marker', since: '1.72' },
  'kui-steps-label': { component: 'Steps', part: 'label', since: '1.72' },
  'kui-steps-state': { component: 'Steps', part: 'state', since: '1.72' },
  'kui-site-nav-toggle': { component: 'SiteNav', part: 'toggle', since: '1.72' },
  'kui-site-nav-toggle-menu': { component: 'SiteNav', part: 'menuIcon', since: '1.72' },
  'kui-site-nav-toggle-close': { component: 'SiteNav', part: 'closeIcon', since: '1.72' },
  'kui-site-nav-list': { component: 'SiteNav', part: 'list', since: '1.72' },
  'kui-site-nav-link': { component: 'SiteNav', part: 'link', since: '1.72' },
  'kui-site-nav-icon': { component: 'SiteNav', part: 'icon', since: '1.72' },
  'kui-app-header-brand': { component: 'AppHeader', part: 'brand', since: '1.72' },
  'kui-app-header-nav': { component: 'AppHeader', part: 'nav', since: '1.72' },
  'kui-app-header-end': { component: 'AppHeader', part: 'end', since: '1.72' },
  'kui-spinner': { component: 'Button', part: 'spinner', since: '1.72' },
  'kui-form-field-head': { component: 'FormField', part: 'head', since: '1.72' },
  'kui-form-field-label': { component: 'FormField', part: 'label', since: '1.72' },
  'kui-form-field-action': { component: 'FormField', part: 'action', since: '1.72' },
  'kui-form-field-required': { component: 'FormField', part: 'required', since: '1.72' },
  'kui-form-field-hint': { component: 'FormField', part: 'hint', since: '1.72' },
  'kui-form-field-issues': { component: 'FormField', part: 'issues', since: '1.72' },
  'kui-form-field-issue': { component: 'FormField', part: 'issue', since: '1.72' },
  'kui-checkbox-input': { component: 'Checkbox', part: 'input', since: '1.72' },
  'kui-checkbox-label': { component: 'Checkbox', part: 'label', since: '1.72' },
  'kui-checkbox-hint': { component: 'Checkbox', part: 'hint', since: '1.72' },
  'kui-toggle-input': { component: 'Toggle', part: 'input', since: '1.72' },
  'kui-toggle-track': { component: 'Toggle', part: 'track', since: '1.72' },
  'kui-toggle-label': { component: 'Toggle', part: 'label', since: '1.72' },
  'kui-radio': { component: 'RadioGroup', part: 'radio', since: '1.72' },
  'kui-radio-choice': { component: 'RadioGroup', part: 'choice', since: '1.72' },
  'kui-radio-input': { component: 'RadioGroup', part: 'input', since: '1.72' },
  'kui-radio-label': { component: 'RadioGroup', part: 'label', since: '1.72' },
  'kui-radio-description': { component: 'RadioGroup', part: 'description', since: '1.72' },
  'kui-segmented-option': { component: 'Segmented', part: 'option', since: '1.72' },
  'kui-segmented-input': { component: 'Segmented', part: 'input', since: '1.72' },
  'kui-segmented-icon': { component: 'Segmented', part: 'icon', since: '1.72' },
  'kui-segmented-label': { component: 'Segmented', part: 'label', since: '1.72' },
  'kui-rating-stars': { component: 'Rating', part: 'stars', since: '1.72' },
  'kui-rating-fill': { component: 'Rating', part: 'fill', since: '1.72' },
  'kui-slider-label': { component: 'Slider', part: 'label', since: '1.72' },
  'kui-slider-input': { component: 'Slider', part: 'input', since: '1.72' },
  'kui-slider-value': { component: 'Slider', part: 'value', since: '1.72' },
  'kui-color-input-input': { component: 'ColorInput', part: 'input', since: '1.72' },
  'kui-color-input-label': { component: 'ColorInput', part: 'label', since: '1.72' },
  'kui-color-input-value': { component: 'ColorInput', part: 'value', since: '1.72' },
  'kui-date-input-box': { component: 'DateInput', part: 'input', since: '1.72' },
  'kui-date-input-trigger': { component: 'DateInput', part: 'trigger', since: '1.72' },
  'kui-date-input-panel': { component: 'DateInput', part: 'panel', since: '1.72' },
  'kui-date-input-head': { component: 'DateInput', part: 'head', since: '1.72' },
  'kui-date-input-title': { component: 'DateInput', part: 'title', since: '1.72' },
  'kui-date-input-step': { component: 'DateInput', part: 'step', since: '1.72' },
  'kui-date-input-grid': { component: 'DateInput', part: 'grid', since: '1.72' },
  'kui-date-input-weekday': { component: 'DateInput', part: 'weekday', since: '1.72' },
  'kui-date-input-day': { component: 'DateInput', part: 'day', since: '1.72' },
  'kui-date-input-today': { component: 'DateInput', part: 'today', since: '1.72' },
  'kui-date-range-input-separator': { component: 'DateRangeInput', part: 'separator', since: '1.72' },
  'kui-combobox-list': { component: 'Combobox', part: 'list', since: '1.72' },
  'kui-combobox-option': { component: 'Combobox', part: 'option', since: '1.72' },
  'kui-combobox-status': { component: 'Combobox', part: 'status', since: '1.72' },
  'kui-multi-select-panel': { component: 'MultiSelect', part: 'panel', since: '1.72' },
  'kui-multi-select-trigger': { component: 'MultiSelect', part: 'trigger', since: '1.72' },
  'kui-multi-select-summary': { component: 'MultiSelect', part: 'summary', since: '1.72' },
  'kui-multi-select-chevron': { component: 'MultiSelect', part: 'chevron', since: '1.72' },
  'kui-multi-select-search': { component: 'MultiSelect', part: 'search', since: '1.72' },
  'kui-multi-select-bar': { component: 'MultiSelect', part: 'bar', since: '1.72' },
  'kui-multi-select-action': { component: 'MultiSelect', part: 'action', since: '1.72' },
  'kui-multi-select-options': { component: 'MultiSelect', part: 'options', since: '1.72' },
  'kui-multi-select-option': { component: 'MultiSelect', part: 'option', since: '1.72' },
  'kui-multi-select-checkbox': { component: 'MultiSelect', part: 'checkbox', since: '1.72' },
  'kui-multi-select-icon': { component: 'MultiSelect', part: 'icon', since: '1.72' },
  'kui-multi-select-label': { component: 'MultiSelect', part: 'label', since: '1.72' },
  'kui-multi-select-empty': { component: 'MultiSelect', part: 'empty', since: '1.72' },
  'kui-chip-input': { component: 'ChipGroup', part: 'input', since: '1.72' },
  'kui-chip-label': { component: 'ChipGroup', part: 'label', since: '1.72' },
  'kui-chip-icon': { component: 'ChipGroup', part: 'icon', since: '1.72' },
  'kui-file-drop-input': { component: 'FileDrop', part: 'input', since: '1.72' },
  'kui-copy-btn-text': { component: 'CopyButton', part: 'text', since: '1.72' },
  'kui-copy-btn-live': { component: 'CopyButton', part: 'live', since: '1.72' },
  'kui-confirm-delete-armed': { component: 'ConfirmDelete', part: 'armed', since: '1.72' },
  'kui-confirm-delete-message': { component: 'ConfirmDelete', part: 'message', since: '1.72' },
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
