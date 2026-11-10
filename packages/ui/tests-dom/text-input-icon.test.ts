import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import TextIconFlip from '../tests/fixture/src/components/text-icon-flip.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('a TextInput draws and drops its icon as `icon` and `type` change, keeping what is typed', async () => {
  mounted = await mountComponent(TextIconFlip)
  await settle()

  const root = mounted.root
  const icon = () => root.querySelector('[data-part=icon]')
  const box = () => root.querySelector<HTMLInputElement>('#box')!
  const press = async (id: string) => {
    click(root.querySelector(`#${id}`))
    await settle()
  }

  expect(icon()).toBeNull()
  expect(box().closest('[data-part=field]')).toBeNull()

  box().value = 'moon'
  box().dispatchEvent(new Event('input', { bubbles: true }))
  await settle()

  await press('search')
  expect(icon()?.getAttribute('aria-hidden')).toBe('true')
  expect(box().closest('[data-part=field]')).not.toBeNull()
  expect(box().hasAttribute('data-icon')).toBe(true)
  expect(box().value).toBe('moon')

  await press('none')
  expect(icon()).toBeNull()
  expect(box().hasAttribute('data-icon')).toBe(false)
  expect(box().value).toBe('moon')

  await press('globe')
  expect(icon()).not.toBeNull()

  await press('auto')
  await press('text')
  expect(icon()).toBeNull()
  expect(box().value).toBe('moon')
})
