// One row of a BarList.
export interface BarListRow {
  key: string | number
  label: string
  value: number
  // What the row reads on its right, the value as it is when omitted.
  display?: string
}

// One dot of a `ScatterChart`.
export interface ScatterPoint {
  key: string | number
  label: string
  x: number
  y: number
  // Relative dot area, any unit, 1 when omitted.
  weight?: number
  // Hover text, the label when omitted.
  tooltip?: string
}

export interface AxisTick {
  value: number
  label: string
}

// How values spread along an axis: `log` compresses a long tail, reading anything below 1 as 1.
export type AxisScale = 'linear' | 'log'

export interface ScatterAxis {
  label?: string
  scale?: AxisScale
  // The values the axis spans, the points' own extent when omitted.
  domain?: readonly [number, number]
  ticks?: readonly AxisTick[]
}

function scaled(value: number, scale: AxisScale): number {
  return scale === 'log' ? Math.log10(Math.max(1, value)) : value
}

// The span an axis covers once scaled, from its domain or else from the values it plots, never empty.
export function axisExtent(values: readonly number[], axis: ScatterAxis): [number, number] {
  const scale = axis.scale ?? 'linear'
  const source = axis.domain ?? values

  if (source.length === 0)
    return [0, 1]

  const low = Math.min(...source.map(value => scaled(value, scale)))
  const high = Math.max(...source.map(value => scaled(value, scale)))

  return low === high ? [low, low + 1] : [low, high]
}

// Where `value` sits along an axis spanning `extent`, as a percentage from its start, clamped to the plot.
export function axisPercent(value: number, extent: readonly [number, number], scale: AxisScale = 'linear'): number {
  const [low, high] = extent

  return Math.min(100, Math.max(0, ((scaled(value, scale) - low) / (high - low)) * 100))
}

const MIN_DOT_REM = 0.625
const MAX_DOT_REM = 1.75

// A dot's diameter in rem, its area following its weight against the heaviest point.
export function dotSize(weight: number, heaviest: number): number {
  return MIN_DOT_REM + (MAX_DOT_REM - MIN_DOT_REM) * Math.sqrt(Math.max(0, weight) / Math.max(heaviest, 1e-9))
}

// One line of a LineChart.
export interface ChartSeries {
  name: string
  // One reading per label; `null` leaves a gap in the line rather than drawing a zero.
  values: (number | null)[]
  // Any CSS colour; a series without one takes the next `--color-kui-chart-*` token.
  color?: string
}

// The dash each series of a LineChart draws with, by its place in the list, so lines stay apart without their colours: solid, then patterns in px of a 2px stroke, no dash shorter than the stroke is wide.
export const SERIES_DASHES = ['', '6 3', '2 3', '10 3 2 3', '2 6', '8 2 2 2'] as const

// A horizontal sample of a dashed line as a CSS background, for the legend to show each series as its line draws.
export function dashSample(color: string, dash: string): string {
  const lengths = dash.split(' ').filter(Boolean).map(Number)

  if (lengths.length === 0)
    return `background-color: ${color}`

  let at = 0
  const stops = lengths.map((length, index) => {
    const stop = `${index % 2 === 0 ? color : 'transparent'} ${at}px ${at + length}px`

    at += length

    return stop
  })

  return `background-image: repeating-linear-gradient(90deg, ${stops.join(', ')})`
}

const KEY_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, Home: -Infinity, End: Infinity }

// Where a key moves a point along a line of `count` points from `index`: the arrows step one, Home and End reach either end; undefined for any other key.
export function steppedPoint(key: string, index: number, count: number): number | undefined {
  const step = KEY_STEPS[key]

  return step === undefined ? undefined : Math.min(Math.max(0, count - 1), Math.max(0, index + step))
}

// The colours a chart gives its series in turn, the `--color-kui-chart-*` tokens.
export const PALETTE = ['var(--kui-chart-1)', 'var(--kui-chart-2)', 'var(--kui-chart-3)', 'var(--kui-chart-4)', 'var(--kui-chart-5)', 'var(--kui-chart-6)']

// One series of a `BarChart`.
export interface BarSeries extends ChartSeries {
  // One colour per label, any CSS colour, taking over the series' own where set: an up run green, a failed one red.
  colors?: (string | null | undefined)[]
  // One message per label, added to that bar's tooltip and announcement.
  notes?: (string | null | undefined)[]
}

// The smallest 1, 2, 4, 6, 8 or 10 times a power of ten that holds `value`, so the middle tick of a plot spanning it is a round number too.
function niceTop(value: number): number {
  const scale = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 4, 6, 8, 10].find(candidate => value / scale <= candidate + 1e-9) ?? 10

  return Number((step * scale).toPrecision(12))
}

// The height of each of `count` bars as a share of the plot (0 to 1), a stacked series laid on the ones before it, and the top value the plot spans, the highest reading rounded up to a round number. Only positive, finite readings draw a bar.
export function barRatios(values: readonly (readonly (number | null)[])[], stacked: boolean, count: number): { heights: number[][], top: number } {
  const positive = (row: readonly (number | null)[], at: number) => {
    const value = row[at]

    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
  }
  let top = 0

  for (let at = 0; at < count; at++) {
    let own = 0

    for (const row of values)
      own = stacked ? own + positive(row, at) : Math.max(own, positive(row, at))

    top = Math.max(top, own)
  }

  if (top > 0)
    top = niceTop(top)

  return { heights: values.map(row => Array.from({ length: count }, (_, at) => top > 0 ? positive(row, at) / top : 0)), top }
}

// The grid lines of a bar plot as shares of its height: the baseline, the middle and the top, or the baseline alone when nothing is positive.
export function valueTicks(top: number): { ratio: number }[] {
  return top > 0 ? [{ ratio: 0 }, { ratio: 0.5 }, { ratio: 1 }] : [{ ratio: 0 }]
}
