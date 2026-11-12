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

test('every control with a label takes showLabel: off by default on the groups, on by default on the text controls, and the label names the control either way', async () => {
  mounted = await mountComponent(ShownLabel, {})

  const root = mounted.root

  for (const [id, label] of [['radio', 'Plan'], ['rating', 'Score'], ['range', 'Price'], ['dates', 'Stay'], ['rows', 'Links'], ['combo', 'Country']] as const) {
    const shown = root.querySelector(`#${id}-shown`)!
    const hidden = root.querySelector(`#${id}-hidden`)!
    const heading = shown.getAttribute('aria-labelledby')

    expect(heading).not.toBeNull()
    expect(root.querySelector(`[id="${heading}"]`)?.textContent).toBe(label)
    expect(shown.getAttribute('aria-label')).toBeNull()
    expect(shown.closest('[data-part=field]')?.querySelector('[data-part=heading], [data-part=title]')).not.toBeNull()
    expect(hidden.getAttribute('aria-label')).toBe(`Hidden ${label.toLowerCase()}`)
    expect(hidden.getAttribute('aria-labelledby')).toBeNull()
    expect(hidden.closest('[data-part=field]')).toBeNull()
  }

  expect(root.querySelector('#rating-static')!.getAttribute('aria-labelledby')).not.toBeNull()
  expect(root.querySelector('#slider-shown')!.closest('[data-part=root]')?.querySelector('[data-part=label]')?.textContent).toBe('Delay')

  for (const id of ['slider-hidden', 'color-hidden']) {
    const control = root.querySelector(`#${id}`)!

    expect(control.closest('[data-part=root]')?.querySelector('[data-part=label]')).toBeNull()
    expect(control.getAttribute('aria-label')).toMatch(/^Hidden/)
  }

  for (const id of ['check-hidden', 'toggle-hidden']) {
    const control = root.querySelector(`#${id}`)!

    expect(control.closest('[data-part=root]')?.querySelector('[data-part=label]')).toBeNull()
    expect(control.getAttribute('aria-label')).toMatch(/^Hidden/)
  }

  const shownCheck = root.querySelector('#check-shown')!

  expect(shownCheck.getAttribute('aria-label')).toBeNull()
  expect(shownCheck.closest('[data-part=root]')?.querySelector('[data-part=label]')?.textContent).toBe('Shown check')
})
