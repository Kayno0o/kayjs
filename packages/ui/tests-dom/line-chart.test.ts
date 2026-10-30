import type { Mounted } from 'kay/test'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { FixedScaleAxis } from 'chartist'
import { mountComponent } from 'kay/test'
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
