import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import Tones from '../tests/fixture/src/components/tones.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

const TONES = ['neutral', 'accent', 'success', 'warning', 'danger', 'info']
// The colour each tone paints; neutral is the quiet one of every component.
const COLORS = ['muted', 'accent', 'success', 'warning', 'danger', 'info']

function classes(element: Element | null | undefined) {
  return [...element?.classList ?? []].join(' ')
}

test('a Menu entry of every tone but the default draws its own colour', async () => {
  mounted = await mountComponent(Tones)

  const items = [...mounted.root.querySelectorAll('#menu [data-part=item]')]

  expect(items.map(item => item.getAttribute('data-tone'))).toEqual(TONES)

  for (const [at, tone] of TONES.entries()) {
    if (tone !== 'neutral' && tone !== 'danger')
      expect(classes(items[at]), tone).toContain(`data-[tone=${tone}]:text-${tone}`)
  }
})

test('a Sparkline bar, a StatusStrip cell, a Timeline icon and a Stat figure take the colour of each tone', async () => {
  mounted = await mountComponent(Tones)

  const { root } = mounted
  const bars = [...root.querySelectorAll('#spark [data-part=bar]')]
  const cells = [...root.querySelectorAll('#strip [data-part=cell]')]
  const icons = [...root.querySelectorAll('#timeline [data-part=icon]')]
  const stats = [...root.querySelectorAll('#stats [data-part=value]')]

  expect([bars, cells, icons, stats].map(list => list.length)).toEqual([6, 6, 6, 6])

  for (const [at, tone] of TONES.entries()) {
    const color = COLORS[at]!

    expect(bars[at]!.getAttribute('data-tone'), tone).toBe(tone)
    expect(classes(bars[at]), tone).toContain(`data-[tone=${tone}]:bg-${color}`)
    expect(classes(cells[at]), tone).toContain(`data-[tone=${tone}]:bg-${color}`)
    expect(classes(icons[at]), tone).toContain(`group-data-[tone=${tone}]/entry:text-${color}`)

    if (tone !== 'neutral')
      expect(classes(stats[at]), tone).toContain(`text-${color}`)
  }
})

test('a warning toast is drawn in the warning tone', async () => {
  mounted = await mountComponent(Tones)

  click(mounted.root.querySelector('#warn'))
  await settle()

  const item = mounted.root.querySelector('.kui-toast')!

  expect(item.getAttribute('data-tone')).toBe('warning')
  expect(classes(item)).toContain('data-[tone=warning]:[--_toast-tone:var(--color-warning)]')
})
