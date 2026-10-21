import { describe, expect, it } from 'bun:test'
import { markRebuilding, REBUILD_WINDOW, rebuildingFor } from '../src/editor/rebuild'

function storage() {
  const items = new Map<string, string>()

  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) }
}

describe('rebuilding', () => {
  it('holds for the window after a save, then lets go', () => {
    const kept = storage()

    expect(rebuildingFor(kept, 1000)).toBe(0)
    markRebuilding(kept, 1000)
    expect(rebuildingFor(kept, 1000)).toBe(REBUILD_WINDOW)
    expect(rebuildingFor(kept, 1000 + REBUILD_WINDOW - 1)).toBe(1)
    expect(rebuildingFor(kept, 1000 + REBUILD_WINDOW)).toBe(0)
  })

  it('reads as none without storage or with an unreadable value', () => {
    expect(rebuildingFor(undefined)).toBe(0)
    expect(rebuildingFor({ getItem: () => 'soon' })).toBe(0)
    expect(rebuildingFor({ getItem: () => {
      throw new Error('blocked')
    } })).toBe(0)
    expect(() => markRebuilding({ setItem: () => {
      throw new Error('full')
    } })).not.toThrow()
  })
})
