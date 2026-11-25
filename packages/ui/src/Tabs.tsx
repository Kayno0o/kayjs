/** @jsxImportSource @kayjs/kay */
// Accessible Tabs primitive with roving arrow-key + Home/End keyboard navigation.

import type { KayChild } from '@kayjs/kay'
import { createTabs } from './behaviors'

export interface TabDef {
  id: string
  label: string
  content: KayChild
}

export interface TabsProps {
  items: TabDef[]
  defaultValue?: string | undefined
  label?: string | undefined
  class?: string | undefined
}

export function Tabs({ items, defaultValue, label = 'Tabs', class: cls }: TabsProps) {
  const ids = items.map(i => i.id)
  const tabs = createTabs(defaultValue ?? items[0]?.id ?? '')

  return (
    <div data-ui="tabs" class={cls}>
      <div data-part="list" role="tablist" aria-label={label}>
        {items.map(item => (
          <button
            key={item.id}
            id={`tab-${item.id}`}
            data-part="trigger"
            data-state={tabs.isActive(item.id) ? 'active' : 'inactive'}
            role="tab"
            type="button"
            aria-selected={tabs.isActive(item.id) ? 'true' : 'false'}
            aria-controls={`panel-${item.id}`}
            tabIndex={tabs.isActive(item.id) ? 0 : -1}
            onClick={() => tabs.select(item.id)}
            onKeyDown={e => tabs.onKeyDown(e, ids)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map(item => (
        <div
          key={item.id}
          id={`panel-${item.id}`}
          data-part="panel"
          data-state={tabs.isActive(item.id) ? 'active' : 'inactive'}
          role="tabpanel"
          aria-labelledby={`tab-${item.id}`}
          hidden={!tabs.isActive(item.id)}
        >
          {item.content}
        </div>
      ))}
    </div>
  )
}
