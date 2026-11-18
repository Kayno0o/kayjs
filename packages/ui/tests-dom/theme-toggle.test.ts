import type { Mounted } from 'kay/test'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import Icons from '../tests/fixture/src/components/theme-toggle-icons.kay'
import { library } from './dom'

let mounted: Mounted | undefined

// A cookie needs a page address to belong to.
beforeEach(() => {
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost/')
})

afterEach(() => {
  mounted?.unmount()
  document.documentElement.removeAttribute('data-theme')
  document.cookie = 'theme=; Max-Age=0; Path=/'
})

const root = () => document.documentElement

test('picking a mode puts it on html, keeps it in the cookie and tells onValueChange', async () => {
  const heard: { value: string }[] = []

  mounted = await mountComponent(await library('theme-toggle'), { onValueChange: (event: { value: string }) => heard.push(event) })
  expect(root().hasAttribute('data-theme')).toBe(false)
  expect([...mounted.root.querySelectorAll('input')].map(input => input.checked)).toEqual([true, false, false])

  await mounted.click('input[value="dark"]')
  expect(root().getAttribute('data-theme')).toBe('dark')
  expect(document.cookie).toContain('theme=')
  expect(heard.map(event => event.value)).toEqual(['dark'])

  await mounted.click('input[value="system"]')
  expect(root().hasAttribute('data-theme')).toBe(false)
  expect(heard.map(event => event.value)).toEqual(['dark', 'system'])
})

test('onValueChange hears one event, and the removed onChange is never called', async () => {
  const heard: unknown[][] = []
  const old: unknown[][] = []

  mounted = await mountComponent(await library('theme-toggle'), {
    onValueChange: (...args: unknown[]) => heard.push(args),
    onChange: (...args: unknown[]) => old.push(args),
  })
  await mounted.click('input[value="dark"]')
  expect(heard).toEqual([[{ value: 'dark', option: expect.objectContaining({ value: 'dark' }) }]])
  expect(old).toEqual([])
})

test('modes picks and words the choices, and a mode stays in the order given', async () => {
  mounted = await mountComponent(await library('theme-toggle'), { modes: ['dark', { value: 'light', label: 'Day' }] })
  expect([...mounted.root.querySelectorAll('label')].map(label => label.textContent?.trim())).toEqual(['Dark', 'Day'])
})

test('a value held by the app is followed and kept out of the cookie', async () => {
  const heard: string[] = []

  mounted = await mountComponent(await library('theme-toggle'), { value: 'light', onValueChange: ({ value }: { value: string }) => heard.push(value) })
  expect(root().getAttribute('data-theme')).toBe('light')

  await mounted.click('input[value="dark"]')
  await settle()
  expect(heard).toEqual(['dark'])
  expect(document.cookie).not.toContain('theme=')
})

test('a change refused by a promise is neither applied for good nor kept', async () => {
  mounted = await mountComponent(await library('theme-toggle'), { onValueChange: async () => false })
  await mounted.click('input[value="dark"]')
  await settle()
  expect(document.cookie).not.toContain('theme=')
  expect([...mounted.root.querySelectorAll('input')].map(input => input.checked)).toEqual([true, false, false])
  expect(root().hasAttribute('data-theme')).toBe(false)
})

test('a promise from onValueChange holds the choice until it resolves', async () => {
  let release: (answer: boolean) => void = () => undefined

  mounted = await mountComponent(await library('theme-toggle'), { onValueChange: async () => new Promise<boolean>(resolve => release = resolve) })
  await mounted.click('input[value="light"]')
  expect(document.cookie).not.toContain('theme=')
  release(true)
  await settle()
  expect(document.cookie).toContain('theme=')
})

test('class reaches the group and its parts, and an option block keeps each radio named', async () => {
  mounted = await mountComponent(Icons)
  expect(mounted.root.querySelector('[role=radiogroup]')?.classList.contains('mine-root')).toBe(true)
  expect(mounted.root.querySelector('[data-part=option]')?.classList.contains('mine-option')).toBe(true)
  expect([...mounted.root.querySelectorAll('input')].map(input => input.getAttribute('aria-label'))).toEqual(['System', 'Light', 'Dark'])
})
