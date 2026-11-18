import { describe, expect, it } from 'bun:test'
import { ACTION } from '../src/runtime/action-shared'
import { child } from '../src/runtime/html'
import { island, IslandPropsError } from '../src/runtime/island.server'

const ASKS = { interactive: { sortable: true, selectable: false } }

interface Props { sortable?: boolean, selectable?: boolean, onPick?: () => void, hydrate?: 'idle', persist?: boolean }

const part = (_props: Props) => null

const drawn = (props: Props, lives: readonly unknown[] = [], asks: Parameters<typeof island>[8] = ASKS) => child(island<Props>('part.kay', part, [], false, 'is interactive', lives, undefined, undefined, asks)(props))

describe('an island that lists the props making it interactive', () => {
  it('is an island by a default that is on, a value that is on, or a function it lists', () => {
    expect(drawn({})).toContain('<slot data-component="part.kay"')
    expect(drawn({ sortable: false, selectable: true })).toContain('<slot')
    expect(() => drawn({ sortable: false, selectable: (() => true) as never })).toThrow(IslandPropsError)
  })

  it('is plain markup when none is on', () => {
    expect(drawn({ sortable: false })).not.toContain('<slot')
    expect(drawn({ sortable: false, selectable: false })).not.toContain('<slot')
  })

  it('is plain markup with a function it does not list, which the server calls', () => {
    let called = 0
    const props = { sortable: false, onPick: () => void called++ }
    const html = child(island<Props>('part.kay', p => p.onPick?.() ?? null, [], false, 'is interactive', [], undefined, undefined, ASKS)(props))

    expect(html).not.toContain('<slot')
    expect(called).toBe(1)
  })

  it('is an island for an action in a prop it does not list, which is sent to the browser', () => {
    const action = Object.assign(() => undefined, { [ACTION]: true, url: '/_kay/action/pick' })

    expect(drawn({ sortable: false, onPick: action })).toContain('<slot')
  })

  it('stays an island where the use asks to hydrate or persist, where the component asks itself, or where it follows a live value', () => {
    expect(drawn({ sortable: false, hydrate: 'idle' })).toContain('<slot')
    expect(drawn({ sortable: false, persist: true })).toContain('<slot')
    expect(drawn({ sortable: false }, [], { ...ASKS, hydrate: 'idle' })).toContain('<slot')
    expect(drawn({ sortable: false }, [{}])).toContain('<slot')
  })

  it('is an island whose component lists nothing', () => {
    expect(drawn({ sortable: false }, [], {})).toContain('<slot')
  })
})
