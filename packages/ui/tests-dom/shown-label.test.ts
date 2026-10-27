import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import ShownLabel from '../tests/fixture/src/components/shown-label.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

function naming(root: ParentNode, id: string) {
  const group = root.querySelector(`#${id}`)!
  const heading = group.getAttribute('aria-labelledby')
  const field = group.parentElement?.getAttribute('data-part') === 'field'

  return {
    ariaLabel: group.getAttribute('aria-label'),
    heading: heading !== null ? root.querySelector(`[id="${heading}"]`)?.textContent : null,
    above: field ? group.previousElementSibling?.getAttribute('data-part') : null,
  }
}

test('a Segmented given showLabel writes its label above the radiogroup and names it by that label, a plain one keeps aria-label', async () => {
  mounted = await mountComponent(ShownLabel, {})

  expect(naming(mounted.root, 'shown')).toEqual({ ariaLabel: null, heading: 'Layout', above: 'heading' })
  expect(naming(mounted.root, 'hidden')).toEqual({ ariaLabel: 'Hidden layout', heading: null, above: null })
  expect(mounted.root.querySelector('#shown')!.getAttribute('role')).toBe('radiogroup')
})

test('a ChipGroup given showLabel writes its label above the chips and names the group by that label, a plain one keeps aria-label', async () => {
  mounted = await mountComponent(ShownLabel, {})

  expect(naming(mounted.root, 'chips-shown')).toEqual({ ariaLabel: null, heading: 'Shapes', above: 'heading' })
  expect(naming(mounted.root, 'chips-hidden')).toEqual({ ariaLabel: 'Hidden shapes', heading: null, above: null })
})
