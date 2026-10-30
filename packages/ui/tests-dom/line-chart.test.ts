import type { Mounted } from 'kay/test'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { FixedScaleAxis } from 'chartist'
import { mountComponent } from 'kay/test'
import LiveChart from '../tests/fixture/src/components/live-chart.kay'
import { untilHolds } from '../tests/until'
import { library } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

async function chart(props: Record<string, unknown>) {
  mounted = await mountComponent(await library('line-chart'), { label: 'Visits', labels: ['2026-01-01', '2026-01-02', '2026-01-11'], series: [{ name: 'Visits', values: [1, 3, 2] }], ...props })

  return mounted.root
}

test('sets no global Chartist, which chartist/compat sets up for 1.x plugin scripts when imported', async () => {
  const warn = spyOn(console, 'warn')

  try {
    await chart({})
    await chart({})
    expect('Chartist' in globalThis).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  }
  finally {
    warn.mockRestore()
  }
})

test('draws with the 1.x FixedScaleAxis class an app still passes as the x axis, on the ticks it gives', async () => {
  const day = (date: string) => new Date(date).getTime()
  const root = await chart({ xLabels: true, options: { axisX: { type: FixedScaleAxis, low: day('2026-01-01'), high: day('2026-01-11'), ticks: [day('2026-01-01'), day('2026-01-06'), day('2026-01-11')], labelInterpolationFnc: (value: number) => `t${new Date(value).getUTCDate()}` } } })

  expect(root.querySelectorAll('.ct-line')).toHaveLength(1)
  expect([...root.querySelectorAll('.ct-label.ct-horizontal')].map(label => label.textContent)).toEqual(['t1', 't6', 't11'])
})

interface Rolling {
  roll: () => void
  recolor: () => void
}

async function rolling(props: Record<string, unknown> = {}) {
  let api: Rolling | undefined

  mounted = await mountComponent(LiveChart, { bind: (found: Rolling) => api = found, xLabels: true, ...props })
  await untilHolds(() => mounted!.root.querySelector('.ct-line') !== null)

  return { root: mounted.root, api: api! }
}

const tick = (root: ParentNode, text: string) => [...root.querySelectorAll('.ct-label.ct-horizontal')].find(label => label.textContent === text)

test('updates in place when the data a signal feeds changes: the svg and its line stay, with the new path and colour', async () => {
  const { root, api } = await rolling()
  const svg = root.querySelector('svg')!
  const line = root.querySelector('.ct-line')!
  const path = line.getAttribute('d')

  expect(line.getAttribute('style')).toContain('red')
  api.roll()
  await untilHolds(() => line.getAttribute('d') !== path)
  expect(root.querySelector('svg')).toBe(svg)
  expect(root.querySelector('.ct-line')).toBe(line)

  api.recolor()
  await untilHolds(() => line.getAttribute('style')?.includes('blue') === true)
  expect(root.querySelector('.ct-line')).toBe(line)
})

test('follows the points of a rolling series by label: the label that stays is the same element, the one dropped is gone', async () => {
  const { root, api } = await rolling()
  const thursday = tick(root, 'Thu')

  expect(thursday).toBeDefined()
  expect(tick(root, 'Mon')).toBeDefined()
  api.roll()
  await untilHolds(() => tick(root, 'Day 1') !== undefined)
  expect(tick(root, 'Thu')).toBe(thursday)
  expect(tick(root, 'Mon')).toBeUndefined()
})

test('follows the points of a rolling series by label by default: the points that stay keep their elements, a new one is drawn', async () => {
  const { root, api } = await rolling({ showPoints: true })
  const before = [...root.querySelectorAll('.ct-point')]

  expect(before).toHaveLength(4)
  api.roll()
  await untilHolds(() => tick(root, 'Day 1') !== undefined)

  const after = [...root.querySelectorAll('.ct-point')]

  expect(after.filter(point => before.includes(point))).toHaveLength(3)
  expect(after).toHaveLength(4)
})

test('follows them by position with pointKey index, so every point keeps its element', async () => {
  const { root, api } = await rolling({ showPoints: true, pointKey: 'index' })
  const before = [...root.querySelectorAll('.ct-point')]

  api.roll()
  await untilHolds(() => tick(root, 'Day 1') !== undefined)
  expect([...root.querySelectorAll('.ct-point')]).toEqual(before)
})

const motion = (root: ParentNode) => root.querySelectorAll('animate, animateTransform').length

test('animates an update only once animate is set, and not while the system asks for reduced motion', async () => {
  const still = await rolling()

  still.api.roll()
  await untilHolds(() => tick(still.root, 'Day 1') !== undefined)
  expect(motion(still.root)).toBe(0)
  mounted?.unmount()

  const moving = await rolling({ animate: true })

  moving.api.roll()
  await untilHolds(() => tick(moving.root, 'Day 1') !== undefined)
  expect(motion(moving.root)).toBeGreaterThan(0)
  mounted?.unmount()

  const media = spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList)

  try {
    const reduced = await rolling({ animate: true })

    reduced.api.roll()
    await untilHolds(() => tick(reduced.root, 'Day 1') !== undefined)
    expect(motion(reduced.root)).toBe(0)
  }
  finally {
    media.mockRestore()
  }
})
