import { describe, expect, test } from 'bun:test'
import { BOTTOM, clampSize, DEFAULT_LAYOUT, dockOf, readLayout, revealBy, SIDE, sizeOf, writeLayout } from '../src/editor/dock'

const store = (value: string | null) => ({ getItem: () => value })

describe('the dock', () => {
  test('is the side where the page fits beside the editor, the bottom below that', () => {
    expect(dockOf(DEFAULT_LAYOUT, 1280)).toBe('side')
    expect(dockOf(DEFAULT_LAYOUT, 1024)).toBe('side')
    expect(dockOf(DEFAULT_LAYOUT, 1023)).toBe('bottom')
    expect(dockOf(DEFAULT_LAYOUT, 800)).toBe('bottom')
  })

  test('is the visitor\'s choice, but the bottom in a window too narrow for the side', () => {
    expect(dockOf({ open: true, dock: 'bottom' }, 1600)).toBe('bottom')
    expect(dockOf({ open: true, dock: 'side' }, 800)).toBe('side')
    expect(dockOf({ open: true, dock: 'side' }, 639)).toBe('bottom')
  })
})

describe('the size', () => {
  const room = { width: 1280, height: 800 }

  test('is kept between a minimum and what leaves the page its share, less what another tool holds', () => {
    expect(clampSize('side', 10, room)).toBe(SIDE.min)
    expect(clampSize('side', 5000, room)).toBe(1280 - SIDE.page)
    expect(clampSize('side', 5000, room, 448)).toBe(1280 - 448 - SIDE.page)
    expect(clampSize('bottom', 10, room)).toBe(BOTTOM.min)
    expect(clampSize('bottom', 5000, room)).toBe(800 - BOTTOM.page)
    expect(clampSize('side', 5000, { width: 500, height: 800 })).toBe(SIDE.min)
  })

  test('defaults to 24rem at the side and half the window at the bottom', () => {
    expect(sizeOf(DEFAULT_LAYOUT, 'side', room)).toBe(384)
    expect(sizeOf(DEFAULT_LAYOUT, 'bottom', room)).toBe(400)
    expect(sizeOf({ open: true, side: 500, bottom: 300 }, 'side', room)).toBe(500)
    expect(sizeOf({ open: true, side: 500, bottom: 300 }, 'bottom', room)).toBe(300)
  })
})

describe('the kept layout', () => {
  test('round trips, and anything else is the default', () => {
    const saved: string[] = []

    writeLayout({ setItem: (_key, value) => void saved.push(value) }, { open: false, dock: 'bottom', side: 400, bottom: 260 })
    expect(readLayout(store(saved[0]!))).toEqual({ open: false, dock: 'bottom', side: 400, bottom: 260 })
    expect(readLayout(store(null))).toEqual({ open: true })
    expect(readLayout(store('nope'))).toEqual(DEFAULT_LAYOUT)
    expect(readLayout(store('null'))).toEqual(DEFAULT_LAYOUT)
    expect(readLayout(store('{"dock":"top","side":"wide","bottom":null}'))).toEqual({ open: true })
    expect(readLayout({ getItem: () => {
      throw new Error('blocked')
    } })).toEqual(DEFAULT_LAYOUT)
  })

  test('writing into blocked storage is quiet', () => {
    expect(() => writeLayout({ setItem: () => {
      throw new Error('blocked')
    } }, DEFAULT_LAYOUT)).not.toThrow()
  })
})

describe('revealing a box', () => {
  const visible = { top: 0, bottom: 400 }

  test('scrolls nothing for a box already in the visible part', () => {
    expect(revealBy({ top: 100, bottom: 200 }, visible)).toBe(0)
  })

  test('scrolls up for a box above and down for one under the editor', () => {
    expect(revealBy({ top: -80, bottom: -20 }, visible)).toBe(-80)
    expect(revealBy({ top: 450, bottom: 500 }, visible)).toBe(100)
  })

  test('shows the top of a box taller than the visible part', () => {
    expect(revealBy({ top: 300, bottom: 900 }, visible)).toBe(300)
  })
})
