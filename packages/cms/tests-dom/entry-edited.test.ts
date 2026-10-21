import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  document.documentElement.lang = ''
})

test('the day an entry was last edited is written once the browser says its zone, keeping the exact time in the tag', async () => {
  const at = Date.UTC(2026, 9, 20, 23, 30)

  document.documentElement.lang = 'fr'
  mounted = await mountComponent('../../src/components/entry-edited.kay', { at })
  await settle()

  const time = mounted.root.querySelector('time')!

  expect(time.getAttribute('datetime')).toBe('2026-10-20T23:30:00.000Z')
  expect(time.textContent).toMatch(/2026/u)
  expect(time.textContent).not.toBe('2026-10-20')
})
