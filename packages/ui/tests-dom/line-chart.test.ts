import type { Mounted } from 'kay/test'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { FixedScaleAxis } from 'chartist'
import { mountComponent } from 'kay/test'
import LiveChart from '../tests/fixture/src/components/live-chart.kay'
import { untilHolds } from '../tests/until'
import { library } from './dom'

let mounted: Mounted | undefined

// The loaders a mounted chart goes through are read from here, as `mountComponent` bundles the component with a copy of src/chartist.ts of its own.
const loaders: { live?: () => Promise<typeof import('chartist/live')>, compat?: () => Promise<typeof import('chartist/compat')> } = {}

;(globalThis as Record<symbol, unknown>)[Symbol.for('kayjs-ui.chartist-loaders')] = loaders
const realLive = async () => import('chartist/live')

afterEach(() => {
  delete loaders.live
  delete loaders.compat
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
  labels: (on: boolean) => void
}

async function rolling(props: Record<string, unknown> = {}) {
  let api: Rolling | undefined

  mounted = await mountComponent(LiveChart, { bind: (found: Rolling) => api = found, xLabels: true, ...props })
  await untilHolds(() => mounted!.root.querySelector('.ct-line') !== null)

  return { root: mounted.root, api: api! }
}

const tick = (root: ParentNode, text: string) => [...root.querySelectorAll('.ct-label.ct-horizontal')].find(label => label.textContent === text)

// The first change of the data draws with the plain renderer while chartist/live loads: this makes it, so what follows is patched in place.
async function warm(root: ParentNode, api: Rolling) {
  api.roll()
  await untilHolds(() => tick(root, 'Day 1') !== undefined)
  await Bun.sleep(150)
}

test('updates in place when the data a signal feeds changes: the svg and its line stay, with the new path and colour', async () => {
  const { root, api } = await rolling()

  await warm(root, api)

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

  await warm(root, api)

  const thursday = tick(root, 'Thu')

  expect(thursday).toBeDefined()
  expect(tick(root, 'Tue')).toBeDefined()
  api.roll()
  await untilHolds(() => tick(root, 'Day 2') !== undefined)
  expect(tick(root, 'Thu')).toBe(thursday)
  expect(tick(root, 'Tue')).toBeUndefined()
})

test('follows the points of a rolling series by label by default: the points that stay keep their elements, a new one is drawn', async () => {
  const { root, api } = await rolling({ showPoints: true })

  await warm(root, api)

  const before = [...root.querySelectorAll('.ct-point')]

  expect(before).toHaveLength(4)
  api.roll()
  await untilHolds(() => tick(root, 'Day 2') !== undefined)

  const after = [...root.querySelectorAll('.ct-point')]

  expect(after.filter(point => before.includes(point))).toHaveLength(3)
  expect(after).toHaveLength(4)
})

test('follows them by position with pointKey index, so every point keeps its element', async () => {
  const { root, api } = await rolling({ showPoints: true, pointKey: 'index' })

  await warm(root, api)

  const before = [...root.querySelectorAll('.ct-point')]

  api.roll()
  await untilHolds(() => tick(root, 'Day 2') !== undefined)
  expect([...root.querySelectorAll('.ct-point')].map((point, index) => point === before[index])).toEqual([true, true, true, true])
})

const motion = (root: ParentNode) => root.querySelectorAll('animate, animateTransform').length

test('animates an update only once animate is set, and not while the system asks for reduced motion', async () => {
  const still = await rolling()

  still.api.roll()
  await untilHolds(() => tick(still.root, 'Day 1') !== undefined)
  expect(motion(still.root)).toBe(0)
  mounted?.unmount()

  const moving = await rolling({ animate: true })

  await warm(moving.root, moving.api)
  moving.api.roll()
  await untilHolds(() => tick(moving.root, 'Day 2') !== undefined)
  expect(motion(moving.root)).toBeGreaterThan(0)
  mounted?.unmount()

  const media = spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList)

  try {
    const reduced = await rolling({ animate: true })

    await warm(reduced.root, reduced.api)
    reduced.api.roll()
    await untilHolds(() => tick(reduced.root, 'Day 2') !== undefined)
    expect(motion(reduced.root)).toBe(0)
  }
  finally {
    media.mockRestore()
  }
})

// A loader the test settles itself, counting its calls.
function held() {
  const state = { calls: 0, release: () => undefined as void, fail: (_: Error) => undefined as void }

  loaders.live = async () => {
    state.calls += 1
    await new Promise<void>((resolve, reject) => {
      state.release = resolve
      state.fail = reject
    })

    return realLive()
  }

  return state
}

const stray: unknown[] = []

process.on('unhandledRejection', reason => void stray.push(reason))

test('draws the x labels an app turns on after the first change of the data', async () => {
  const { root, api } = await rolling({ xLabels: false })

  api.roll()
  await untilHolds(() => root.querySelector('.ct-line')?.getAttribute('d') !== null)
  await Bun.sleep(300)
  expect(root.querySelectorAll('.ct-label.ct-horizontal')).toHaveLength(0)
  api.labels(true)
  await untilHolds(() => tick(root, 'Day 1') !== undefined)
  expect(tick(root, 'Day 1')).toBeDefined()
})

test('never asks for the live renderer while the data stays the same', async () => {
  const gate = held()

  await rolling()
  await Bun.sleep(150)
  expect(gate.calls).toBe(0)
})

test('keeps drawing with the plain renderer while the live one loads, and ends on the latest data', async () => {
  const gate = held()
  const { root, api } = await rolling()

  api.roll()
  await untilHolds(() => tick(root, 'Day 1') !== undefined)
  api.roll()
  await untilHolds(() => tick(root, 'Day 2') !== undefined)
  expect(gate.calls).toBe(1)
  gate.release()
  await Bun.sleep(100)

  const line = root.querySelector('.ct-line')!

  api.roll()
  await untilHolds(() => tick(root, 'Day 3') !== undefined)
  expect(root.querySelector('.ct-line')).toBe(line)
  expect(tick(root, 'Day 2')).toBeDefined()
})

test('says so and goes on redrawing when chartist/live cannot be loaded', async () => {
  const error = spyOn(console, 'error').mockImplementation(() => undefined)
  const gate = held()

  try {
    const { root, api } = await rolling()

    api.roll()
    await untilHolds(() => tick(root, 'Day 1') !== undefined)
    gate.fail(new Error('offline'))
    await untilHolds(() => error.mock.calls.length > 0)
    expect(String(error.mock.calls[0]![0])).toContain('chartist/live')
    api.roll()
    await untilHolds(() => tick(root, 'Day 2') !== undefined)
    expect(tick(root, 'Day 2')).toBeDefined()
  }
  finally {
    error.mockRestore()
  }
})

test('draws nothing more when the chart is gone before the live renderer arrives', async () => {
  const error = spyOn(console, 'error').mockImplementation(() => undefined)
  const gate = held()

  try {
    const { api } = await rolling()

    api.roll()
    await untilHolds(() => gate.calls === 1)
    mounted?.unmount()
    mounted = undefined
    gate.release()
    await Bun.sleep(100)
    expect(error).not.toHaveBeenCalled()
    expect(stray).toEqual([])
  }
  finally {
    error.mockRestore()
  }
})

test('hands a function pointKey each point\'s series, position and label', async () => {
  const seen: string[] = []
  const { root, api } = await rolling({ showPoints: true, pointKey: (point: { series: number, index: number, label: string }) => {
    seen.push(`${point.series}:${point.index}:${point.label}`)

    return point.index
  } })

  await warm(root, api)

  const before = [...root.querySelectorAll('.ct-point')]

  api.roll()
  await untilHolds(() => tick(root, 'Day 2') !== undefined)
  expect(seen).toContain('0:3:Day 2')
  expect(before).toHaveLength(4)
  expect([...root.querySelectorAll('.ct-point')].map((point, index) => point === before[index])).toEqual([true, true, true, true])
})

test('follows points by position by default when labels repeat', async () => {
  const { root, api } = await rolling({ showPoints: true, first: ['A', 'A', 'B', 'B'] })

  await warm(root, api)

  const before = [...root.querySelectorAll('.ct-point')]

  api.roll()
  await untilHolds(() => tick(root, 'Day 2') !== undefined)
  expect(before).toHaveLength(4)
  expect([...root.querySelectorAll('.ct-point')].map((point, index) => point === before[index])).toEqual([true, true, true, true])
})

test('runs the 1.x draw handler and the legacy plugin function an app passes, without loading chartist/live', async () => {
  const gate = held()
  const drawn: string[] = []
  const plugged: unknown[] = []
  const { root, api } = await rolling({ extra: {
    on: { draw: (event: { type: string }) => void drawn.push(event.type) },
    plugins: [(chart: unknown) => void plugged.push(chart)],
  } })

  expect(drawn).toContain('line')
  expect(plugged).toHaveLength(1)
  api.roll()
  await untilHolds(() => tick(root, 'Day 1') !== undefined)
  await Bun.sleep(150)
  expect(gate.calls).toBe(0)
  expect('Chartist' in globalThis).toBe(false)
})

test('says chartist/compat failed and draws without the legacy parts when it cannot be loaded', async () => {
  const error = spyOn(console, 'error').mockImplementation(() => undefined)

  loaders.compat = async () => {
    throw new Error('offline')
  }

  try {
    const drawn: string[] = []
    const root = await chart({ options: { on: { draw: (event: { type: string }) => void drawn.push(event.type) }, plugins: [() => undefined] } })

    await untilHolds(() => error.mock.calls.length > 0)
    expect(String(error.mock.calls[0]![0])).toContain('chartist/compat')
    await untilHolds(() => root.querySelector('.ct-line') !== null)
    expect(drawn).toEqual([])
  }
  finally {
    error.mockRestore()
  }
})

test('draws with a plugins option that is not an array', async () => {
  const root = await chart({ options: { plugins: 'nope' } })

  await untilHolds(() => root.querySelector('.ct-line') !== null)
})
