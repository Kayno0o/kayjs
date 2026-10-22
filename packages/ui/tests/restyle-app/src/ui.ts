import { defineUi } from 'kay'

// The restyle test reads these classes back from the pages of the components.
export default defineUi({
  '@kaynooo/kayjs-ui/card.kay': { parts: { root: 'rounded-xl', head: 'p-6', title: 'italic' } },
  '@kaynooo/kayjs-ui/button.kay': { parts: { spinner: 'size-5' }, variants: { variant: { inline: { root: 'tracking-wide' } }, tone: { danger: { root: 'bg-red-600' } } } },
  '@kaynooo/kayjs-ui/badge.kay': { variants: { tone: { success: { root: 'bg-green-100' } } } },
  '@kaynooo/kayjs-ui/notice.kay': { variants: { tone: { danger: 'border-2' } } },
  '@kaynooo/kayjs-ui/text-input.kay': { parts: 'h-12' },
  '@kaynooo/kayjs-ui/textarea.kay': { parts: 'min-h-32' },
  '@kaynooo/kayjs-ui/dialog.kay': { parts: { title: 'text-xl', footer: 'justify-end' } },
  '@kaynooo/kayjs-ui/table.kay': { parts: { root: 'gap-3', table: 'text-sm', headCell: 'uppercase', cell: 'py-4', sortIcon: 'size-4', filterInput: 'w-64', count: 'text-xs', selection: 'mb-2' } },
  '@kaynooo/kayjs-ui/avatar.kay': { parts: { initial: 'font-bold' } },
  '@kaynooo/kayjs-ui/stat.kay': { parts: { value: 'tabular-nums' } },
  '@kaynooo/kayjs-ui/page-header.kay': { parts: { title: 'tracking-tight' } },
  '@kaynooo/kayjs-ui/page-section.kay': { parts: { head: 'mb-4' } },
  '@kaynooo/kayjs-ui/empty-state.kay': { parts: { description: 'italic' } },
  '@kaynooo/kayjs-ui/card-row.kay': { parts: { body: 'px-4' } },
  '@kaynooo/kayjs-ui/date-input.kay': { parts: { root: 'gap-2', input: 'w-44', trigger: 'p-2', panel: 'w-72', day: 'h-9' } },
  '@kaynooo/kayjs-ui/date-range-input.kay': { parts: { separator: 'mx-1' } },
  '@kaynooo/kayjs-ui/time-input.kay': { parts: 'w-32' },
})
