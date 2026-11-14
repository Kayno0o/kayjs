import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import Bound from '../tests/fixture/src/components/carousel-bound.kay'
import { click, clock } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

test('bind:index writes the parent signal on each turn and follows it back', async () => {
  mounted = await mountComponent(Bound, {})

  const { root } = mounted
  const shown = () => [...root.querySelectorAll('[data-part="slide"]')].filter(slide => !slide.hasAttribute('inert') && !slide.hasAttribute('aria-hidden')).map(slide => slide.getAttribute('aria-label'))

  expect([shown(), root.querySelector('#index')!.textContent]).toEqual([['Slide 1 of 3'], '0'])

  click(root.querySelector('[data-part="step"][data-side="next"]'))
  await clock.settle()
  expect([shown(), root.querySelector('#index')!.textContent]).toEqual([['Slide 2 of 3'], '1'])

  click(root.querySelector('#jump'))
  await clock.settle()
  expect([shown(), root.querySelector('#index')!.textContent]).toEqual([['Slide 3 of 3'], '2'])
})
