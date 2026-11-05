import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import OldActions from '../tests/fixture/src/components/old-actions.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

test('the block names before 1.90 still draw their content', async () => {
  mounted = await mountComponent(OldActions, {})
  await settle()

  const old = (id: string) => mounted!.root.querySelector(`#${id} .old`)?.textContent

  expect(old('card')).toBe('Old head')
  expect(old('header')).toBe('Old end')
  expect(old('field')).toBe('Old action')
  expect(old('tree')).toBe('Old a')
  expect(mounted.root.querySelector('[data-part=extra] .old')?.textContent).toBe('Old tool ')
})

test('a ConfirmDelete\'s trigger string still picks the button', async () => {
  mounted = await mountComponent(OldActions, {})

  expect(mounted.root.querySelector('#confirm')?.textContent).toContain('Remove')
  expect(mounted.root.querySelector('#confirm')?.tagName).toBe('BUTTON')
})
