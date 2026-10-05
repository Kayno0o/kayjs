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
  // Any CSS colour; a series without one takes the next `--color-chart-*` token.
  color?: string
}
