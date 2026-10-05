import type { AxisOptions, LineChartData } from 'chartist'
import { formatDayMonth, parseDateLabel } from '@kaynooo/utils/date'
import { FixedScaleAxis } from 'chartist'

// The most x-axis labels drawn, first and last always among them.
const MAX_TICKS = 5

// The band under the plot the x-axis labels sit in: one line of them and nothing more.
const X_AXIS_OFFSET = 18

function axisLabel(label: string): string {
  const date = parseDateLabel(label)

  return date && !Number.isNaN(date.getTime()) ? formatDayMonth(date) : label
}

// Up to `MAX_TICKS` evenly spread indices, the first and the last included.
export function tickIndices(total: number): number[] {
  if (total <= MAX_TICKS)
    return Array.from({ length: total }, (_, index) => index)

  return Array.from({ length: MAX_TICKS }, (_, index) => Math.round((index * (total - 1)) / (MAX_TICKS - 1)))
}

// Each label's time when every label is a date and they span some time, so points sit at their real distance apart rather than evenly.
export function labelTimes(labels: string[]): number[] | null {
  if (labels.length < 2)
    return null

  const times = labels.map(label => parseDateLabel(label)?.getTime() ?? Number.NaN)

  return times.some(Number.isNaN) || times[0] === times.at(-1) ? null : times
}

export function chartData(labels: string[], series: (number | null)[][], times: number[] | null): LineChartData {
  return { labels, series: times ? series.map(values => values.map((value, index) => ({ x: times[index]!, y: value }))) : series }
}

export function xAxisOptions(labels: string[], times: number[] | null, showLabels: boolean): AxisOptions {
  if (!showLabels)
    return { showLabel: false, showGrid: false }

  const ticks = tickIndices(labels.length)

  if (times) {
    return {
      type: FixedScaleAxis,
      low: times[0],
      high: times.at(-1),
      ticks: ticks.map(index => times[index]!),
      showLabel: true,
      showGrid: false,
      offset: X_AXIS_OFFSET,
      labelInterpolationFnc: value => formatDayMonth(new Date(Number(value))),
    }
  }

  const shown = new Set(ticks)

  return { showLabel: true, showGrid: false, offset: X_AXIS_OFFSET, labelInterpolationFnc: (value, index) => (shown.has(index) ? axisLabel(String(value)) : null) }
}

// How far across the plot, from 0 to 1, the point at `index` sits.
export function positionOf(index: number, count: number, times: number[] | null): number {
  if (times) {
    const span = times.at(-1)! - times[0]!

    return span === 0 ? 0 : (times[index]! - times[0]!) / span
  }

  return count <= 1 ? 0 : index / (count - 1)
}

// The point nearest a position across the plot, from 0 to 1.
export function indexAt(position: number, count: number, times: number[] | null): number {
  if (count <= 1)
    return 0

  if (!times)
    return Math.round(Math.min(1, Math.max(0, position)) * (count - 1))

  const target = times[0]! + position * (times.at(-1)! - times[0]!)
  let nearest = 0

  for (const [index, time] of times.entries()) {
    if (Math.abs(time - target) < Math.abs(times[nearest]! - target))
      nearest = index
  }

  return nearest
}
