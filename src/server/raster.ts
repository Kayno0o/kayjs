import type { OutlinePoint } from './face'

// An RGB image being drawn on, three bytes a pixel, row after row.
export interface Canvas {
  width: number
  height: number
  pixels: Uint8Array
}

export type Color = readonly [number, number, number]

interface Point {
  x: number
  y: number
}

// Where an outline in font units lands: `size` pixels to the em, its origin at `x`, `y` on the canvas, y growing downward there and upward in the font.
export interface Placement {
  scale: number
  x: number
  y: number
}

// Fills an outline with anti-aliased edges, by the nonzero rule, blending `color` in at `opacity`.
export function fillOutline(canvas: Canvas, contours: OutlinePoint[][], placement: Placement, color: Color, opacity = 1): void {
  const placed = contours.filter(contour => contour.length > 1).map(contour => contour.map(point => ({ x: placement.x + point.x * placement.scale, y: placement.y - point.y * placement.scale, on: point.on })))
  const all = placed.flat()

  if (all.length === 0)
    return

  // Each outline accumulates in a buffer of its own, its control points bounding the curves, with room at either side for the cells an edge spills into.
  const left = Math.floor(Math.min(...all.map(point => point.x))) - 2
  const top = Math.floor(Math.min(...all.map(point => point.y))) - 2
  const width = Math.ceil(Math.max(...all.map(point => point.x))) - left + 3
  const height = Math.ceil(Math.max(...all.map(point => point.y))) - top + 3
  const area = new Float32Array(width * height)

  for (const contour of placed)
    flatten(contour, (from, to) => accumulate(area, width, height, { x: from.x - left, y: from.y - top }, { x: to.x - left, y: to.y - top }))

  for (let y = 0; y < height; y++) {
    const row = top + y
    let sum = 0

    for (let x = 0; x < width; x++) {
      sum += area[y * width + x]!

      const column = left + x
      const alpha = Math.min(1, Math.abs(sum)) * opacity

      if (alpha > 0 && row >= 0 && row < canvas.height && column >= 0 && column < canvas.width)
        blend(canvas, (row * canvas.width + column) * 3, color, alpha)
    }
  }
}

function blend(canvas: Canvas, at: number, color: Color, alpha: number): void {
  for (let channel = 0; channel < 3; channel++)
    canvas.pixels[at + channel] = Math.round(canvas.pixels[at + channel]! + (color[channel]! - canvas.pixels[at + channel]!) * alpha)
}

// A TrueType contour as straight lines: on-curve points are passed through, an off-curve one is a quadratic control point, and two off-curve points in a row imply an on-curve one midway.
function flatten(contour: (Point & { on: boolean })[], line: (from: Point, to: Point) => void): void {
  const first = contour.findIndex(point => point.on)
  const points = first < 0 ? [{ ...midpoint(contour.at(-1)!, contour[0]!), on: true }, ...contour] : [...contour.slice(first), ...contour.slice(0, first)]
  let current: Point = points[0]!
  let control: Point | undefined

  for (const point of [...points.slice(1), points[0]!]) {
    if (point.on) {
      if (control)
        curve(current, control, point, line)
      else
        line(current, point)

      current = point
      control = undefined
    }
    else if (control) {
      const middle = midpoint(control, point)

      curve(current, control, middle, line)
      current = middle
      control = point
    }
    else {
      control = point
    }
  }
}

// Enough segments that the curve strays from them by well under a pixel, more the more it bends.
function curve(from: Point, control: Point, to: Point, line: (from: Point, to: Point) => void): void {
  const bend = (from.x - 2 * control.x + to.x) ** 2 + (from.y - 2 * control.y + to.y) ** 2

  if (bend < 0.333) {
    line(from, to)

    return
  }

  const steps = 1 + Math.floor(Math.sqrt(Math.sqrt(3 * bend)))
  let previous = from

  for (let step = 1; step <= steps; step++) {
    const t = step / steps
    const [a, b, c] = [(1 - t) ** 2, 2 * t * (1 - t), t ** 2]
    const next = step === steps ? to : { x: a * from.x + b * control.x + c * to.x, y: a * from.y + b * control.y + c * to.y }

    line(previous, next)
    previous = next
  }
}

// Adds a line's signed area to the cells it crosses, row by row, so that summing a row from the left gives each pixel's coverage (the accumulation font-rs draws with).
function accumulate(area: Float32Array, width: number, height: number, from: Point, to: Point): void {
  if (from.y === to.y)
    return

  const direction = from.y < to.y ? 1 : -1
  const [start, end] = direction === 1 ? [from, to] : [to, from]
  const slope = (end.x - start.x) / (end.y - start.y)
  let x = start.x

  for (let y = Math.max(0, Math.floor(start.y)); y < Math.min(height, Math.ceil(end.y)); y++) {
    const rowStart = y * width
    const dy = Math.min(y + 1, end.y) - Math.max(y, start.y)
    const next = x + slope * dy
    const d = dy * direction
    const [x0, x1] = x < next ? [x, next] : [next, x]
    const floor0 = Math.floor(x0)
    const ceil1 = Math.ceil(x1)

    if (ceil1 <= floor0 + 1) {
      const middle = 0.5 * (x + next) - floor0

      area[rowStart + floor0] = area[rowStart + floor0]! + d - d * middle
      area[rowStart + floor0 + 1] = area[rowStart + floor0 + 1]! + d * middle
    }
    else {
      const inverse = 1 / (x1 - x0)
      const fraction0 = x0 - floor0
      const first = 0.5 * inverse * (1 - fraction0) ** 2
      const fraction1 = x1 - ceil1 + 1
      const last = 0.5 * inverse * fraction1 ** 2

      area[rowStart + floor0] = area[rowStart + floor0]! + d * first

      if (ceil1 === floor0 + 2) {
        area[rowStart + floor0 + 1] = area[rowStart + floor0 + 1]! + d * (1 - first - last)
      }
      else {
        const second = inverse * (1.5 - fraction0)

        area[rowStart + floor0 + 1] = area[rowStart + floor0 + 1]! + d * (second - first)

        for (let column = floor0 + 2; column < ceil1 - 1; column++)
          area[rowStart + column] = area[rowStart + column]! + d * inverse

        const covered = second + (ceil1 - floor0 - 3) * inverse

        area[rowStart + ceil1 - 1] = area[rowStart + ceil1 - 1]! + d * (1 - covered - last)
      }

      area[rowStart + ceil1] = area[rowStart + ceil1]! + d * last
    }

    x = next
  }
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}
