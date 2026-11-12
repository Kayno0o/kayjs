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

  it('keeps a signal of each entry apart from the others of the same name', () => {
    const local = persisted.local('entries', 'a')
    const session = persisted.session('entries', 'a')
    const cookie = persisted.cookie('entries', 'a')

    expect(new Set([local, session, cookie]).size).toBe(3)
    expect(persisted.local('entries', 'b')).toBe(local)
    expect(persisted.session('entries', 'b')).toBe(session)
    expect(persisted.cookie('entries', 'b')).toBe(cookie)
    expect(persisted('entries', 'b')).toBe(cookie)
    expect(persisted('entries', 'b', { storage: 'local' })).toBe(local)
  })

  it('keeps the deprecated storage option on the entry it names', () => {
    expect(persisted('entries', 'a', { storage: 'query' })).not.toBe(persisted.cookie('entries', 'a'))
    expect(persisted('entries', 'a', { storage: 'local' })).toBe(persisted.local('entries', 'a'))
  })

  it('keeps and reads a value in sessionStorage, localStorage staying empty', () => {
    const step = persisted.session('wizard', 'one', { values: ['one', 'two'] })

    step.set('two')
    expect(sessionStorage.getItem('wizard')).toBe(encodeValue('two'))
    expect(localStorage.getItem('wizard')).toBeNull()
  })

  it('follows the storage event of its own area for local and session, and no other', () => {
    const local = persisted.local('both', 'none')
    const session = persisted.session('both', 'none')

    window.dispatchEvent(new StorageEvent('storage', { storageArea: sessionStorage, key: 'both', newValue: encodeValue('tab') }))
    expect(session()).toBe('tab')
    expect(local()).toBe('none')

    storageEvent({ key: 'both', newValue: encodeValue('everywhere') })
    expect(local()).toBe('everywhere')
    expect(session()).toBe('tab')

    window.dispatchEvent(new StorageEvent('storage', { storageArea: sessionStorage, key: 'both', newValue: null }))
    expect(session()).toBe('none')
    expect(local()).toBe('everywhere')
  })

  it('leaves a session signal alone with sync: false', () => {
    const shared = persisted.session('quiet-session', 'a')
    const alone = persisted.session('quiet-session', 'a', { sync: false })

    expect(alone).not.toBe(shared)
    window.dispatchEvent(new StorageEvent('storage', { storageArea: sessionStorage, key: 'quiet-session', newValue: encodeValue('b') }))
    expect(shared()).toBe('b')
    expect(alone()).toBe('a')
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

describe('persisted signals without a channel, or before hydration', () => {
  beforeAll(() => GlobalRegistrator.register())
  afterAll(async () => GlobalRegistrator.unregister())

  it('writes a cookie without a BroadcastChannel in a module of its own', async () => {
    const saved = globalThis.BroadcastChannel

    // @ts-expect-error -- a browser without one
    delete globalThis.BroadcastChannel

    try {
      const path = '../src/runtime/persist.ts?no-channel'
      const fresh = await import(path) as typeof import('../src/runtime/persist')
      let value = 'a'
      const kept = fresh.keepValue('plain', 'cookie', () => value, (next) => {
        value = next
      }, undefined, undefined, true, 'a')

      expect(() => kept.save('b')).not.toThrow()
    }
    finally {
      globalThis.BroadcastChannel = saved
    }
  })

  it('applies a storage event that arrives before the signal is first read', () => {
    const early = persisted('early', 'none', { storage: 'local' })

    window.dispatchEvent(new StorageEvent('storage', { storageArea: localStorage, key: 'early', newValue: encodeValue('set') }))
    expect(early()).toBe('set')
  })

  it('ignores a channel message that is not a name and a text', () => {
    const odd = persisted('odd', 'a')

    fromOtherTab('nonsense')
    fromOtherTab([1, 2])
    fromOtherTab(null)
    expect(odd()).toBe('a')
  })
})
