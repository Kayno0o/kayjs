import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })

  document.activeElement!.dispatchEvent(event)

  return event
}

test('moves focus between the headers with the arrows, wrapping, and Home and End', async () => {
  mounted = await mountComponent('src/components/moon-accordion.kay')

  const summaries = [...mounted.root.querySelectorAll('summary')] as [HTMLElement, HTMLElement, HTMLElement]

  summaries[1].focus()
  key('ArrowDown')
  await settle()
  expect(document.activeElement).toBe(summaries[2])

  key('ArrowDown')
  expect(document.activeElement).toBe(summaries[0])

  key('ArrowUp')
  expect(document.activeElement).toBe(summaries[2])

  key('Home')
  expect(document.activeElement).toBe(summaries[0])

  key('End')
  expect(document.activeElement).toBe(summaries[2])
  expect(key('ArrowDown', { ctrlKey: true }).defaultPrevented).toBe(false)
})

test('shares one name across its sections and opens the flagged one', async () => {
  mounted = await mountComponent('src/components/moon-accordion.kay')

  const sections = [...mounted.root.querySelectorAll('details')]

  expect(new Set(sections.map(section => section.getAttribute('name'))).size).toBe(1)
  expect(sections[0]!.getAttribute('name')).not.toBeNull()
  expect(sections.map(section => section.open)).toEqual([false, true, false])
})
