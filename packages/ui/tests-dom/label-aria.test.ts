import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { library } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

test('label names a text control as its aria-label, which still wins where both are written', async () => {
  for (const name of ['text-input', 'textarea', 'select', 'date-input', 'time-input', 'date-time-input']) {
    const props = name === 'select' ? { options: [{ value: 'a', label: 'A' }] } : {}

    for (const [given, named] of [[{ label: 'Due' }, 'Due'], [{ 'label': 'Due', 'aria-label': 'Deadline' }, 'Deadline']] as const) {
      const field = await mountComponent(await library(name), { ...props, ...given })

      await settle()
      expect(field.root.querySelector('input, textarea, select')?.getAttribute('aria-label')).toBe(named)
      field.unmount()
    }
  }
})
