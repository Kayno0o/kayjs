import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import ComboboxRows from '../tests/fixture/src/components/combobox-rows.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

test('an @option snippet draws each row, which stays named by its label', async () => {
  mounted = await mountComponent(ComboboxRows, {})

  const { root } = mounted
  const input = root.querySelector<HTMLInputElement>('input[role="combobox"]')!

  input.focus()
  await settle()

  const rows = [...root.querySelectorAll<HTMLElement>('[role="option"]')]

  expect(rows.map(row => [row.querySelector('strong')?.textContent, row.querySelector('code')?.textContent, row.getAttribute('aria-label')])).toEqual([['Fix login', 'Ada · 1a2b3c4', 'Fix login'], ['Add search', 'Grace · 9f8e7d6', 'Add search']])

  click(rows[1]!)
  await settle()

  expect(input.value).toBe('Add search')
})
