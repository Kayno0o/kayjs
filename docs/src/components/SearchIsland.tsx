import { CommandPalette } from '@kayjs/ui'

export interface SearchDocItem {
  id: string
  label: string
  href: string
  section: string
}

export function SearchIsland({ items }: { items: SearchDocItem[] }) {
  return (
    <CommandPalette
      $hydrate="idle"
      triggerLabel="Search (⌘K)"
      placeholder="Jump to a doc page…"
      items={items.map(item => ({
        id: item.id,
        label: item.label,
        shortcut: item.section,
        href: item.href,
      }))}
    />
  )
}
