// Tabs behavior (roving arrow-key + Home/End navigation).

import type { Signal } from '@kayjs/kay'
import { selector, signal } from '@kayjs/kay'

export interface TabsBehavior {
  readonly active: Signal<string>
  select(id: string): void
  isActive(id: string): boolean
  onKeyDown(e: KeyboardEvent, ids: readonly string[]): void
}

export function createTabs(initial: string): TabsBehavior {
  const active = signal(initial)
  const sel = selector(() => active.value)

  return {
    active,
    select(id: string) { active.value = id },
    isActive: (id: string) => sel.is(id),
    onKeyDown(e: KeyboardEvent, ids: readonly string[]) {
      const idx = ids.indexOf(active.value)
      if (idx === -1 || ids.length === 0)
        return
      let next = -1
      if (e.key === 'ArrowRight') next = (idx + 1) % ids.length
      else if (e.key === 'ArrowLeft') next = (idx - 1 + ids.length) % ids.length
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = ids.length - 1
      if (next !== -1) {
        e.preventDefault()
        active.value = ids[next]!
        const tablist = (e.currentTarget as HTMLElement | null)?.closest('[role="tablist"]')
        const buttons = tablist?.querySelectorAll<HTMLElement>('[role="tab"]')
        buttons?.[next]?.focus()
      }
    },
  }
}
