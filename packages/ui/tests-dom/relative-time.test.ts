import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import RelativeTime from '../src/relative-time.kay'

let mounted: Mounted | undefined

document.documentElement.lang = 'en'

afterEach(() => {
  mounted?.unmount()
})

test('a RelativeTime in the browser words the date relative to now, with the full date as a tab stop\'s tooltip', async () => {
  const date = new Date(Date.now() - 3 * 3_600_000)

  mounted = await mountComponent(RelativeTime, { date })
  await settle()

  const time = mounted.root.querySelector('time')!

  expect([time.textContent, time.getAttribute('datetime'), time.getAttribute('tabindex')]).toEqual(['3 hours ago', date.toISOString(), '0'])
  expect(time.getAttribute('data-tooltip')).toContain(String(date.getFullYear()))
})

test('a RelativeTime renders nothing for a date it cannot read', async () => {
  mounted = await mountComponent(RelativeTime, { date: 'nope' })
  await settle()

  expect(mounted.root.querySelector('time')).toBeNull()
})
