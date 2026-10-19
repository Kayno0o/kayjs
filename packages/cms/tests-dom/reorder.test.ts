import { expect, test } from 'bun:test'
import { announceMove } from '../src/editor/reorder'

test('a moved list item is said to a screen reader through one polite live region, its place counted from 1', () => {
  const said = () => document.querySelector('[data-kui-announce]')?.textContent?.trim()

  announceMove('Tag', 1, 3)

  expect(said()).toBe('Moved Tag to 2 of 3')

  announceMove('Tag', 2, 3)

  expect(said()).toBe('Moved Tag to 3 of 3')
  expect(document.querySelectorAll('[data-kui-announce][role="status"][aria-live="polite"]').length).toBe(1)
})
