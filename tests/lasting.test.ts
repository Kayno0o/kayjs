import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'

type Core = typeof import('../src/runtime/core')
type Reactive = typeof import('../src/runtime/reactive')

let core: Core
let reactive: Reactive
let leave: typeof import('../src/runtime/leave')
let shortcut: typeof import('../src/runtime/shortcut')
let followLog: typeof import('../src/runtime/follow-log')
let presence: typeof import('../src/runtime/presence')

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/form' })
  core = await import('../src/runtime/core')
  reactive = await import('../src/runtime/reactive')
  leave = await import('../src/runtime/leave')
  shortcut = await import('../src/runtime/shortcut')
  followLog = await import('../src/runtime/follow-log')
  presence = await import('../src/runtime/presence')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

// Runs `make` as an island's script does, returning what ends the island and what `make` returned.
function island<T>(make: () => T): { dispose: () => void, handle: T } {
  let handle!: T
  const dispose = reactive.root((dispose) => {
    handle = make()

    return dispose
  })

  reactive.flush()

  return { dispose, handle }
}

const press = (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

describe('the handle of a helper that lasts as long as an island', () => {
  it('every: stops the timer, once or twice, or on abort', async () => {
    const run = mock(() => undefined)
    const { handle } = island(() => core.every('5ms', run, { background: true }))

    await Bun.sleep(100)
    expect(run.mock.calls.length).toBeGreaterThan(0)

    handle()
    handle()

    const after = run.mock.calls.length

    await Bun.sleep(30)
    expect(run.mock.calls.length).toBe(after)

    const abort = new AbortController()
    const aborted = mock(() => undefined)

    island(() => core.every('5ms', aborted, { background: true, signal: abort.signal }))
    abort.abort()
    await Bun.sleep(30)
    expect(aborted).not.toHaveBeenCalled()

    const again = mock(() => undefined)

    island(() => core.every('5ms', again, { background: true, signal: abort.signal }))
    await Bun.sleep(30)
    expect(again).not.toHaveBeenCalled()
  })

  it('every: still ends with the island', async () => {
    const run = mock(() => undefined)
    const { dispose } = island(() => core.every('5ms', run, { background: true }))

    dispose()
    await Bun.sleep(30)
    expect(run).not.toHaveBeenCalled()
  })

  it('watch: stops watching', () => {
    const [read, write] = reactive.createSignal(0)
    const seen: number[] = []
    const { handle } = island(() => core.watch(read, next => seen.push(next)))

    write(1)
    reactive.flush()
    handle()
    handle()
    write(2)
    reactive.flush()
    expect(seen).toEqual([1])

    const abort = new AbortController()
    const signalled: number[] = []

    island(() => core.watch(read, next => signalled.push(next), { signal: abort.signal }))
    write(3)
    reactive.flush()
    abort.abort()
    write(4)
    reactive.flush()
    expect(signalled).toEqual([3])
  })

  it('listen: stops listening, once or twice, or on abort', () => {
    const target = document.createElement('div')
    const heard = mock(() => undefined)
    const { handle } = island(() => core.listen(target, 'click', heard))

    target.click()
    handle()
    handle()
    target.click()
    expect(heard).toHaveBeenCalledTimes(1)

    const abort = new AbortController()
    const signalled = mock(() => undefined)

    island(() => core.listen(target, 'click', signalled, { signal: abort.signal }))
    target.click()
    abort.abort()
    target.click()
    expect(signalled).toHaveBeenCalledTimes(1)
  })

  it('shortcut: stops binding the key, once or twice, or on abort', () => {
    const pressed = mock(() => undefined)
    const { handle } = island(() => shortcut.shortcut('/', pressed))

    press('/')
    handle()
    handle()
    press('/')
    expect(pressed).toHaveBeenCalledTimes(1)

    const abort = new AbortController()
    const signalled = mock(() => undefined)

    island(() => shortcut.shortcut('/', signalled, { signal: abort.signal }))
    press('/')
    abort.abort()
    press('/')
    expect(signalled).toHaveBeenCalledTimes(1)
  })

  it('shortcut: removes the aria-keyshortcuts it put on its element', () => {
    const element = document.createElement('div')
    const { handle } = island(() => shortcut.shortcut('/', () => undefined, { on: element }))

    expect(element.getAttribute('aria-keyshortcuts')).toBe('/')
    handle()
    expect(element.hasAttribute('aria-keyshortcuts')).toBe(false)
  })

  it('guardLeave: stops guarding, once or twice, or on abort', async () => {
    const { leaveGuards } = await import('../src/runtime/navigation')
    const dirty = () => true
    const { handle } = island(() => leave.guardLeave(dirty, { confirm: () => false }))

    expect(leaveGuards.size).toBe(1)
    handle()
    handle()
    expect(leaveGuards.size).toBe(0)

    const abort = new AbortController()

    island(() => leave.guardLeave(dirty, { signal: abort.signal }))
    expect(leaveGuards.size).toBe(1)
    abort.abort()
    expect(leaveGuards.size).toBe(0)
  })

  it('followLog: stops following, once or twice, or on abort', () => {
    const element = document.createElement('ol')
    const remove = mock(() => undefined)

    element.scrollTo = () => undefined
    element.removeEventListener = remove
    document.body.append(element)

    const { handle } = island(() => followLog.followLog(element))

    expect(typeof handle.toBottom).toBe('function')
    handle()
    handle()
    expect(remove).toHaveBeenCalledTimes(1)

    const abort = new AbortController()

    island(() => followLog.followLog(element, { signal: abort.signal }))
    abort.abort()
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('presence: stops reading the room, once or twice, or on abort', () => {
    presence.readPresenceWith(() => ['{"name":"b"}', '{"name":"a"}'])

    const { handle } = island(() => presence.presence('room:stop', { name: 'a' }))

    expect(handle.count()).toBe(2)
    expect(handle.others()).toEqual([{ name: 'b' }])
    handle()
    handle()
    expect(handle.count()).toBe(0)
    expect(handle.others()).toEqual([])

    const abort = new AbortController()
    const { handle: second } = island(() => presence.presence('room:stop', { name: 'a' }, { signal: abort.signal }))

    expect(second.count()).toBe(2)
    abort.abort()
    expect(second.count()).toBe(0)

    expect(presence.presence('room:stop', null, { signal: abort.signal }).count()).toBe(0)
    expect(presence.presence({ signal: abort.signal }).count()).toBe(0)
  })

  it('ends with the island: listen, shortcut, guardLeave, followLog and presence', async () => {
    const { leaveGuards } = await import('../src/runtime/navigation')
    const target = document.createElement('div')
    const heard = mock(() => undefined)
    const pressed = mock(() => undefined)
    const element = document.createElement('ol')
    const remove = mock(() => undefined)

    element.scrollTo = () => undefined
    element.removeEventListener = remove

    const { dispose, handle } = island(() => {
      core.listen(target, 'click', heard)
      shortcut.shortcut('/', pressed)
      leave.guardLeave(() => true)
      followLog.followLog(element)

      return presence.presence('room:island', null)
    })

    expect(leaveGuards.size).toBe(1)
    dispose()
    target.click()
    press('/')
    expect(heard).not.toHaveBeenCalled()
    expect(pressed).not.toHaveBeenCalled()
    expect(leaveGuards.size).toBe(0)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(handle.count()).toBe(0)
  })

  it('lets go of the abort listener when the island ends first', () => {
    const abort = new AbortController()
    const remove = mock(abort.signal.removeEventListener.bind(abort.signal))

    abort.signal.removeEventListener = remove as typeof abort.signal.removeEventListener

    const { dispose } = island(() => core.watch(() => 1, () => undefined, { signal: abort.signal }))

    dispose()
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('watch: may stop itself from its own callback', () => {
    const [read, write] = reactive.createSignal(0)
    const seen: number[] = []
    let stop: () => void = () => undefined

    island(() => {
      stop = core.watch(read, (next) => {
        seen.push(next)
        stop()
      })
    })
    write(1)
    reactive.flush()
    write(2)
    reactive.flush()
    expect(seen).toEqual([1])
  })

  it('starts nothing while the server renders', () => {
    const abort = new AbortController()
    const add = mock(abort.signal.addEventListener.bind(abort.signal))
    const target = document.createElement('div')
    const heard = mock(() => undefined)

    abort.signal.addEventListener = add as typeof abort.signal.addEventListener
    reactive.renderOnServer(() => {
      reactive.root(() => {
        core.listen(target, 'click', heard, { signal: abort.signal })
        core.every('5ms', heard, { signal: abort.signal })
      })
    })
    reactive.flush()
    target.click()
    expect(add).not.toHaveBeenCalled()
    expect(heard).not.toHaveBeenCalled()
  })

  it('takes null as the options of listen', () => {
    const target = document.createElement('div')
    const heard = mock(() => undefined)

    island(() => core.listen(target, 'click', heard, null as unknown as undefined))
    target.click()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('warns once in development for a helper with no owner', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const run = () => undefined

    const stops = [core.every('1s', run), core.every('1s', run)]

    reactive.flush()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('every()')

    for (const stop of stops)
      stop()

    warn.mockRestore()
  })
})
