import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import ItemsOld from '../tests/fixture/src/components/items-old.kay'
import { library } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

test('the names the lists had before 1.105 still draw them', async () => {
  mounted = await mountComponent(ItemsOld, {})
  await settle()

  const { root } = mounted
  const text = (selector: string) => root.querySelector(selector)?.textContent ?? ''

  expect([...root.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['Alpha', 'Beta'])
  expect(root.querySelector('#avatars')?.querySelectorAll('[data-part="root"], [data-part="avatar"], img, span').length).toBeGreaterThan(0)
  expect(text('#entries')).toContain('Home')
  expect(text('#site')).toContain('Rooms')
  expect(text('#header')).toContain('Rooms')
  expect(text('#side')).toContain('Rooms')
  expect(text('#steps')).toContain('Two')
  expect(root.textContent).toContain('Moons')
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
