import type { AxisOptions, FixedScaleAxis, LineChartData } from 'chartist'
import { parseDateLabel } from '@kaynooo/utils/date'
import { dayMonth, fullDate, timeOfDay } from './words'

// The most x-axis labels drawn, first and last always among them.
const MAX_TICKS = 5

// The band under the plot the x-axis labels sit in: one line of them and nothing more.
const X_AXIS_OFFSET = 18

// A date and a time of day, as `2026-10-21T16:12:12.000Z` or `2026-10-21 16:12`; the date alone carries no time.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

// The moment a label names and whether it carries a time of day, or null for a label that is no date.
function parseLabel(label: string): { date: Date, timed: boolean } | null {
  if (DATE_TIME.test(label)) {
    const date = new Date(label.replace(' ', 'T'))

    return Number.isNaN(date.getTime()) ? null : { date, timed: true }
  }

  const date = parseDateLabel(label)

  return date && !Number.isNaN(date.getTime()) ? { date, timed: false } : null
}

function axisLabel(label: string): string {
  const date = parseLabel(label)?.date

  return date ? dayMonth(date) : label
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

  const times = labels.map(label => parseLabel(label)?.date.getTime() ?? Number.NaN)

  return times.some(Number.isNaN) || times[0] === times.at(-1) ? null : times
}

// How long the one-day boundary is: a span under it labels the axis with times of day.
const DAY_MS = 86_400_000

// What an app's `formatLabel` is told besides the label: which point it is, whether it heads the tooltip or sits on the x-axis, how long the labels span in milliseconds (0 when they are not all dates) and whether points sit under a minute apart.
export interface LabelContext {
  index: number
  place: 'tooltip' | 'tick'
  span: number
  seconds: boolean
}

export type LabelFormat = (label: string, context: LabelContext) => string

// Whether two neighbouring date labels sit under a minute apart.
export function secondsApart(labels: string[]): boolean {
  let gap = Number.POSITIVE_INFINITY

  for (let index = 1; index < labels.length; index++) {
    const [before, after] = [parseLabel(labels[index - 1]!), parseLabel(labels[index]!)]

    if (before && after) {
      const apart = Math.abs(after.date.getTime() - before.date.getTime())

      if (apart > 0)
        gap = Math.min(gap, apart)
    }
  }

  return gap < 60_000
}

// How long the labels span, in milliseconds, 0 when they are not all dates.
export function spanOf(times: number[] | null): number {
  return times ? times.at(-1)! - times[0]! : 0
}

// Each label as the tooltip heads it: a date in the page's locale, with its time of day when it has one, seconds when points sit under a minute apart; any other label as written.
export function headings(labels: string[], times: number[] | null, format?: LabelFormat): string[] {
  const seconds = secondsApart(labels)
  const span = spanOf(times)

  return labels.map((label, index) => {
    if (format)
      return format(label, { index, place: 'tooltip', span, seconds })

    const found = parseLabel(label)

    return found ? fullDate(found.date, found.timed && (seconds ? 'seconds' : 'minutes')) : label
  })
}

// Each series laid on top of the ones before it: a point's height is the sum of its own value and the ones below, a `null` counting as 0.
export function stackValues(series: (number | null)[][]): number[][] {
  const totals: number[] = []

  return series.map(values => values.map((value, index) => {
    totals[index] = (totals[index] ?? 0) + (value ?? 0)

    return totals[index]
  }))
}

// What every series adds up to at one point, a `null` counting as 0.
export function totalAt(series: { values: (number | null)[] }[], index: number): number {
  return series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0)
}

export function chartData(labels: string[], series: (number | null)[][], times: number[] | null): LineChartData {
  return { labels, series: times ? series.map(values => values.map((value, index) => ({ x: times[index]!, y: value }))) : series }
}

// `fixedScale` is chartist's `FixedScaleAxis`, handed in so this file loads no chartist: the chart reads it with the rest of chartist once it is drawn.
export function xAxisOptions(labels: string[], times: number[] | null, showLabels: boolean, fixedScale: typeof FixedScaleAxis, format?: LabelFormat): AxisOptions {
  if (!showLabels)
    return { showLabel: false, showGrid: false }

  const ticks = tickIndices(labels.length)
  const span = spanOf(times)
  const seconds = format ? secondsApart(labels) : false

  if (times) {
    const indexOfTime = new Map(ticks.map(index => [times[index]!, index]))

    return {
      type: fixedScale,
      ...times.length > 0 ? { low: times[0]!, high: times.at(-1)! } : {},
      ticks: ticks.map(index => times[index]!),
      showLabel: true,
      showGrid: false,
      offset: X_AXIS_OFFSET,
      labelInterpolationFnc: (value) => {
        const index = indexOfTime.get(Number(value))

        if (format && index !== undefined)
          return format(labels[index]!, { index, place: 'tick', span, seconds })

        return span < DAY_MS ? timeOfDay(new Date(Number(value)), false) : dayMonth(new Date(Number(value)))
      },
    }
  }

  const shown = new Set(ticks)

  return { showLabel: true, showGrid: false, offset: X_AXIS_OFFSET, labelInterpolationFnc: (value, index) => {
    if (!shown.has(index))
      return null

    return format ? format(String(value), { index, place: 'tick', span, seconds }) : axisLabel(String(value))
  } }
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
