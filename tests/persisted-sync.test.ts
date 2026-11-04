import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { persisted } from '../src/runtime'
import { encodeValue } from '../src/runtime/wire'

// Stands for the other tabs of the origin: every instance gets what another instance posts.
const instances = new Set<FakeChannel>()

class FakeChannel {
  listeners: ((event: { data: unknown }) => void)[] = []

  constructor() {
    instances.add(this)
  }

  addEventListener(_type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.push(listener)
  }

  postMessage(data: unknown): void {
    for (const other of instances) {
      if (other !== this) {
        for (const listener of other.listeners)
          listener({ data })
      }
    }
  }
}

// What another tab's channel posts.
const fromOtherTab = (data: unknown) => new FakeChannel().postMessage(data)

function storageEvent(init: StorageEventInit): void {
  window.dispatchEvent(new StorageEvent('storage', { storageArea: localStorage, ...init }))
}

describe('persisted signals of one name in a page', () => {
  beforeAll(() => {
    GlobalRegistrator.register()
    globalThis.BroadcastChannel = FakeChannel as unknown as typeof BroadcastChannel
  })
  afterAll(async () => GlobalRegistrator.unregister())

  it('share one signal per storage and name, the first call\'s default standing', () => {
    const first = persisted('theme-shared', 'light')
    const second = persisted('theme-shared', 'dark')

    expect(second).toBe(first)
    first.set('night')
    expect(second()).toBe('night')
    expect(persisted('theme-shared', 'light', { storage: 'local' })).not.toBe(first)
    expect(persisted('theme-shared', 'light', { storage: 'local' })).toBe(persisted('theme-shared', 'x', { storage: 'local' }))
  })

  it('keeps a signal alone with sync: false', () => {
    const shared = persisted('alone', 'a')
    const alone = persisted('alone', 'a', { sync: false })

    expect(alone).not.toBe(shared)
    expect(persisted('alone', 'a', { sync: false })).not.toBe(alone)
    shared.set('b')
    expect(alone()).toBe('a')
    fromOtherTab(['alone', encodeValue('c')])
    expect(shared()).toBe('c')
    expect(alone()).toBe('a')
  })

  it('follows the storage event for local, a removed key reading the default and a clear too', () => {
    const draft = persisted('draft', 'none', { storage: 'local', values: ['none', 'one', 'two'] })

    storageEvent({ key: 'draft', newValue: encodeValue('one') })
    expect(draft()).toBe('one')

    // Another key, a value outside the values, and text that does not decode leave it as it was.
    storageEvent({ key: 'other', newValue: encodeValue('two') })
    storageEvent({ key: 'draft', newValue: encodeValue('three') })
    storageEvent({ key: 'draft', newValue: '{' })
    expect(draft()).toBe('one')

    storageEvent({ key: 'draft', newValue: null })
    expect(draft()).toBe('none')

    storageEvent({ key: 'draft', newValue: encodeValue('two') })
    storageEvent({ key: null, newValue: null })
    expect(draft()).toBe('none')
  })

  it('ignores the storage event of another storage area', () => {
    const area = persisted('area', 'a', { storage: 'local' })

    window.dispatchEvent(new StorageEvent('storage', { storageArea: sessionStorage, key: 'area', newValue: encodeValue('b') }))
    expect(area()).toBe('a')
  })

  it('follows a message of the channel for a cookie, and posts what it writes once', () => {
    const posted: unknown[] = []
    const listener = new FakeChannel()

    listener.addEventListener('message', event => posted.push(event.data))

    const accent = persisted('accent', 'red')

    fromOtherTab(['accent', encodeValue('blue')])
    expect(accent()).toBe('blue')
    // What a tab hears is not posted on: only the next write is.
    posted.length = 0

    accent.set('green')
    expect(posted).toEqual([['accent', encodeValue('green')]])
  })

  it('leaves a cookie unsynced when the browser has no BroadcastChannel', async () => {
    const saved = globalThis.BroadcastChannel

    // @ts-expect-error -- a browser without one
    delete globalThis.BroadcastChannel
    expect(() => persisted('quiet', 'a').set('b')).not.toThrow()
    globalThis.BroadcastChannel = saved
  })
})
