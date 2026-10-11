import { describe, expect, test } from 'bun:test'
import { fitted, held, movedBy, wheelZoom, zoomedAt } from '../src/zoom'

const FRAME = { width: 400, height: 400 }

describe('a plate under its frame', () => {
  test('starts fitted, and fitting it again is the same plate', () => {
    expect(fitted()).toEqual({ scale: 1, x: 0, y: 0 })
    expect(held(fitted(), FRAME)).toEqual({ scale: 1, x: 0, y: 0 })
  })

  test('holds the point under the pointer still while it is taken in', () => {
    const at = { x: 100, y: 300 }
    const plate = zoomedAt(fitted(), at, 2)

    expect(plate.scale).toBe(2)
    // Whatever was under the pointer is still under it: point * scale + offset lands back on the pointer.
    expect(at.x * plate.scale + plate.x).toBeCloseTo(at.x)
    expect(at.y * plate.scale + plate.y).toBeCloseTo(at.y)
  })

  test('never goes further out than fitted, nor further in than it is allowed', () => {
    expect(zoomedAt(fitted(), { x: 0, y: 0 }, 0.2).scale).toBe(1)
    expect(zoomedAt({ scale: 4, x: 0, y: 0 }, { x: 0, y: 0 }, 10, 8).scale).toBe(8)
    // The clamp swallowed most of that gesture, and the offset only moved by what it really took.
    expect(zoomedAt({ scale: 4, x: -100, y: 0 }, { x: 0, y: 0 }, 10, 8).x).toBe(-200)
  })

  test('cannot be dragged off its own frame', () => {
    const taken = { scale: 2, x: 0, y: 0 }

    expect(held(movedBy(taken, 50, 50), FRAME)).toEqual({ scale: 2, x: 0, y: 0 })
    expect(held(movedBy(taken, -600, -600), FRAME)).toEqual({ scale: 2, x: -400, y: -400 })
    expect(held(movedBy(taken, -100, -100), FRAME)).toEqual({ scale: 2, x: -100, y: -100 })
  })

  test('sits still while it is fitted, however far it is dragged', () => {
    expect(held(movedBy(fitted(), -80, 120), FRAME)).toEqual({ scale: 1, x: 0, y: 0 })
  })

  test('reads a wheel in whatever units the browser reports', () => {
    expect(wheelZoom(-100)).toBeCloseTo(1.15)
    expect(wheelZoom(100)).toBeCloseTo(1 / 1.15)
    // The same notch in lines and in pages takes it further than in pixels, never the other way.
    expect(wheelZoom(-100, 1)).toBeGreaterThan(wheelZoom(-100, 0))
    expect(wheelZoom(-100, 2)).toBeGreaterThan(wheelZoom(-100, 1))
    expect(wheelZoom(0)).toBe(1)
  })
})
