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
