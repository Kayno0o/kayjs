import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
const changes: string[] = []

afterEach(() => {
  mounted?.unmount()
  changes.length = 0
})

async function tabs() {
  mounted = await mount('src/components/planet-tabs.kay', { onChange: (value: string) => changes.push(value) })

  const { root } = mounted
  const shown = () => [...root.querySelectorAll('[role="tab"]')].filter(tab => tab.getAttribute('aria-selected') === 'true').map(tab => tab.textContent)
  const visible = () => [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter(panel => !panel.hidden).map(panel => panel.querySelector('input')?.name)

  return { root, shown, visible }
}

function key(name: string) {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
}

test('shows a clicked tab\'s panel alone, keeping what the others hold', async () => {
  const { root, shown, visible } = await tabs()

  expect([shown(), visible()]).toEqual([['Venus'], ['venus']])

  root.querySelector<HTMLInputElement>('input[name="venus"]')!.value = 'typed'
  click(root.querySelectorAll('[role="tab"]')[2]!)
  await settle()

  expect([shown(), visible()]).toEqual([['Earth'], ['earth']])
  expect(changes).toEqual(['earth'])

  click(root.querySelectorAll('[role="tab"]')[1]!)
  await settle()

  expect(root.querySelector<HTMLInputElement>('input[name="venus"]')?.value).toBe('typed')
})

test('moves between tabs with the arrows, wrapping, and Home and End, focus going with the tab shown', async () => {
  const { root, shown } = await tabs()

  root.querySelectorAll<HTMLElement>('[role="tab"]')[1]!.focus()
  key('ArrowRight')
  await settle()

  expect([shown(), document.activeElement?.textContent]).toEqual([['Earth'], 'Earth'])

  key('ArrowRight')
  await settle()

  expect(shown()).toEqual(['Mars'])

  key('ArrowLeft')
  await settle()

  expect(shown()).toEqual(['Earth'])

  key('Home')
  await settle()

  expect([shown(), document.activeElement?.getAttribute('tabindex')]).toEqual([['Mars'], '0'])

  key('End')
  await settle()

  expect(shown()).toEqual(['Earth'])
  expect(changes).toEqual(['earth', 'mars', 'earth', 'mars', 'earth'])
})
