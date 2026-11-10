import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import StepsWizard from '../tests/fixture/src/components/steps-wizard.kay'
import Steps from '../tests/fixture/src/components/steps.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

test('marks the current step, links the ones behind it and the done ones, and leaves the rest as text', async () => {
  mounted = await mountComponent(Steps, { current: 'details', done: ['account', 'review'] })

  const items = [...mounted.root.querySelectorAll('.kui-steps [data-part="item"]')]

  expect(items.map(item => item.getAttribute('data-step'))).toEqual(['done', 'current', 'done'])
  expect(items.map(item => item.querySelector('a')?.getAttribute('href'))).toEqual(['/signup?plan=pro&step=account', undefined, '/signup?plan=pro&step=review'])
  expect(items[1]!.querySelector('[aria-current="step"]')?.textContent).toContain('Details')
  expect(items[0]!.querySelector('[data-part="state"]')?.textContent).toBe('completed')
})

test('a step ahead of the current one stays plain text', async () => {
  mounted = await mountComponent(Steps, { current: 'account', done: [] })

  expect([...mounted.root.querySelectorAll('.kui-steps [data-part="item"]')].map(item => item.querySelector('a') === null)).toEqual([true, true, true])
})

test('with onSelect and no url a done or linkable step is a button, picking it reports its key, and the rest stays text', async () => {
  const picks: string[] = []

  mounted = await mountComponent(StepsWizard, { picks })

  const items = [...mounted.root.querySelectorAll('#plain [data-part="item"]')]

  expect(items.map(item => item.querySelector('[data-part="link"]')!.tagName)).toEqual(['BUTTON', 'SPAN', 'BUTTON', 'SPAN'])

  click(items[0]!.querySelector('button'))
  click(items[2]!.querySelector('button'))
  await settle()
  expect(picks).toEqual(['account', 'review'])
  expect(mounted.root.querySelector('#plain [aria-current="step"]')?.textContent).toContain('current: Review')
})

test('a step carries its state to the page and to screen readers, its icon in place of the number, and a step block draws its text', async () => {
  mounted = await mountComponent(StepsWizard, { picks: [] })

  const items = [...mounted.root.querySelectorAll('#plain [data-part="item"]')]

  expect(items.map(item => item.getAttribute('data-outcome'))).toEqual([null, 'error', null, 'skipped'])
  expect(items.map(item => item.querySelector('[data-part="state"]')?.textContent)).toEqual(['completed', 'has an error', undefined, 'skipped'])
  expect(items[2]!.querySelector('[data-part="marker"] svg')).not.toBeNull()
  expect(items[0]!.querySelector('[data-part="label"]')?.textContent).toBe('done: Account')
})

test('with a url a clickable step stays a link: a plain click calls onSelect, a modified click is left to the browser', async () => {
  const picks: string[] = []

  mounted = await mountComponent(StepsWizard, { picks, withUrl: true })

  const links = [...mounted.root.querySelectorAll<HTMLAnchorElement>('#linked a')]

  expect(links.map(link => link.getAttribute('href'))).toEqual(['/wizard?plan=pro&step=account', '/wizard?plan=pro&step=review'])

  const plain = new MouseEvent('click', { bubbles: true, cancelable: true })
  const modified = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })

  links[1]!.dispatchEvent(plain)
  links[1]!.dispatchEvent(modified)
  expect([plain.defaultPrevented, modified.defaultPrevented, picks]).toEqual([true, false, ['review']])

  // A handler answering `false` lets the browser follow the link.
  const followed = new MouseEvent('click', { bubbles: true, cancelable: true })

  links[0]!.dispatchEvent(followed)
  expect([followed.defaultPrevented, picks]).toEqual([false, ['review', 'account']])
})
