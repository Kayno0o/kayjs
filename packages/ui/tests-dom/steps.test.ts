import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

test('marks the current step, links the ones behind it and the done ones, and leaves the rest as text', async () => {
  mounted = await mountComponent('src/components/steps.kay', { current: 'details', done: ['account', 'review'] })

  const items = [...mounted.root.querySelectorAll('.kui-steps-item')]

  expect(items.map(item => item.getAttribute('data-state'))).toEqual(['done', 'current', 'done'])
  expect(items.map(item => item.querySelector('a')?.getAttribute('href'))).toEqual(['/signup?plan=pro&step=account', undefined, '/signup?plan=pro&step=review'])
  expect(items[1]!.querySelector('[aria-current="step"]')?.textContent).toContain('Details')
  expect(items[0]!.querySelector('.kui-steps-state')?.textContent).toBe('completed')
})

test('a step ahead of the current one stays plain text', async () => {
  mounted = await mountComponent('src/components/steps.kay', { current: 'account', done: [] })

  expect([...mounted.root.querySelectorAll('.kui-steps-item')].map(item => item.querySelector('a') === null)).toEqual([true, true, true])
})
