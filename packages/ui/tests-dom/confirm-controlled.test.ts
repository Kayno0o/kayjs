import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import Controlled from '../tests/fixture/src/components/confirm-controlled.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function controlled() {
  mounted = await mountComponent(Controlled, { onDelete: async () => Promise.resolve() })

  return mounted.root
}

const pick = (root: Element, menu: string) => click(root.querySelector(`#${menu} [data-part=item]`))
const pair = (root: Element) => root.querySelector('[role=group][aria-label="Remove the row?"]')

test('a Menu entry opens a trigger-less dialog, and a cancel then a confirmed delete report false', async () => {
  const root = await controlled()
  const dialog = () => root.querySelector<HTMLDialogElement>('dialog')
  const states = () => root.querySelector('#states')!.textContent

  expect(root.querySelector('.kui-icon-btn[aria-label="Delete"]')).toBeNull()
  expect(dialog()?.open).not.toBe(true)

  pick(root, 'row-menu')
  await settle()

  expect([dialog()?.open, states()]).toEqual([true, ''])

  click([...dialog()!.querySelectorAll('button')].find(button => button.textContent === 'Cancel') ?? null)
  await settle()

  expect([dialog()?.open === true, states()]).toEqual([false, 'closed'])

  pick(root, 'row-menu')
  await settle()
  click(dialog()!.querySelector('.kui-btn-danger'))
  await settle()

  expect([dialog()?.open === true, states()]).toEqual([false, 'closed,closed'])
})

test('an inline ask armed by the app draws the pair with no trigger, and Escape closes it', async () => {
  const root = await controlled()

  expect(pair(root)).toBeNull()

  pick(root, 'inline-menu')
  await settle()

  expect(pair(root)).not.toBeNull()

  pair(root)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()

  expect(pair(root)).toBeNull()
})

test('an inline ask armed by the app hands the focus back to the element that held it', async () => {
  const root = await controlled()
  const asker = root.querySelector<HTMLElement>('#ask-inline')!

  asker.focus()
  click(asker)
  await settle()

  expect(document.activeElement).not.toBe(asker)

  pair(root)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()

  expect(document.activeElement).toBe(asker)
})
