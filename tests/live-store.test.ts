import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { live, liveSlot, setLiveStore, watchSlot } from '../src/runtime/live-value'
import { setupStore } from '../src/server/app-store'
import { sqliteLive } from '../src/server/sqlite-live'

// The build gives a declaration its id and name; a test passes them itself.
const declare = live as unknown as (initial: number, id: string, name: string) => { (): number, set: (next: number) => void }
const dirs: string[] = []
const VALUE = resolve('src/runtime/live-value.ts')
const STORE = resolve('src/server/sqlite-live.ts')

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

// A process of its own, as a replica or a restart is: declares the values, attaches the store, then runs `body`.
function spawnProcess(path: string, body: string) {
  const script = `import { live, liveSlot, setLiveStore, watchSlot } from ${JSON.stringify(VALUE)}\nimport { sqliteLive } from ${JSON.stringify(STORE)}\nconst count = live(0, 'test:count', 'count')\nconst room = live(id => ({ id, users: 0, since: new Date(0) }), 'test:room', 'room')\nsetLiveStore(sqliteLive(${JSON.stringify(path)}))\n${body}\n`

  return Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'inherit' })
}

async function output(child: ReturnType<typeof spawnProcess>): Promise<string> {
  const [text] = await Promise.all([new Response(child.stdout).text(), child.exited])

  return text.trim()
}

describe('live values in a store', () => {
  async function storePath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kay-live-'))

    dirs.push(dir)

    return join(dir, 'live.sqlite')
  }

  it('reaches the watchers of another process, and a process starting reads what is held', async () => {
    const path = await storePath()
    const watcher = spawnProcess(path, `const heard = []
watchSlot(liveSlot('test:room'), 'a', () => heard.push(room('a').users))
console.log('ready')
for (let wait = 0; wait < 300 && heard.length < 1; wait++)
  await Bun.sleep(10)
console.log(JSON.stringify({ heard, count: count(), since: room('a').since instanceof Date }))
process.exit(0)`)
    const reader = watcher.stdout.getReader()

    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe('ready')

    const setter = spawnProcess(path, 'count.set(n => n + 4)\nroom.set(\'a\', { id: \'a\', users: 1, since: new Date(5) })\nroom.set(\'a\', { id: \'a\', users: 2, since: new Date(5) })')

    await output(setter)

    const rest = new TextDecoder().decode((await reader.read()).value).trim()

    expect(JSON.parse(rest)).toEqual({ heard: [2], count: 4, since: true })

    const restarted = spawnProcess(path, 'console.log(JSON.stringify([count(), room(\'a\').users, room(\'a\').since.getTime(), room(\'b\').users]))\nroom.delete(\'a\')')

    expect(JSON.parse(await output(restarted))).toEqual([4, 2, 5, 0])

    const after = spawnProcess(path, 'console.log(JSON.stringify([count(), room(\'a\').users]))')

    expect(JSON.parse(await output(after))).toEqual([4, 0])
  })

  it('keeps values in memory with no store, and its own ids out of the store', async () => {
    const path = await storePath()
    const store = sqliteLive(path)
    const memory = declare(0, 'test:memory', 'memory')
    const own = declare(0, 'kay:test-own', 'own')

    memory.set(1)
    expect(store.entries()).toEqual([])

    setLiveStore(store)
    memory.set(2)
    own.set(3)
    expect(store.entries()).toEqual([['test:memory', '', '[2]']])
    expect(liveSlot('kay:test-own')).toBeDefined()
    watchSlot(liveSlot('test:memory')!, '', () => undefined)
    setLiveStore(undefined)
    memory.set(5)
    expect(store.entries()).toEqual([['test:memory', '', '[2]']])
  })

  it('gives a value declared after the store attached what it holds', async () => {
    const path = await storePath()
    const store = sqliteLive(path)

    store.set('test:late', '', '[7]')
    setLiveStore(store)

    const late = declare(0, 'test:late', 'late')

    expect(late()).toBe(7)
    setLiveStore(undefined)
  })

  it('reads and writes the store the app setup names, and none after it is removed', async () => {
    const path = await storePath()
    const store = sqliteLive(path)
    const wired = declare(0, 'test:wired', 'wired')

    setupStore({ live: store })
    wired.set(9)
    expect(store.entries()).toEqual([['test:wired', '', '[9]']])
    setupStore(undefined)
    wired.set(10)
    expect(store.entries()).toEqual([['test:wired', '', '[9]']])
  })

  it('tells the watchers of another process a key was deleted, and a value never declared there stays held', async () => {
    const path = await storePath()
    const setter = spawnProcess(path, 'room.set(\'z\', { id: \'z\', users: 3, since: new Date(0) })\nconsole.log(\'set\')\nawait Bun.sleep(1500)\nroom.delete(\'z\')\nroom.delete(\'never\')')

    const reader = setter.stdout.getReader()

    await reader.read()

    const watcher = spawnProcess(path, `const seen = [room('z').users]
watchSlot(liveSlot('test:room'), 'z', () => seen.push(room('z').users))
for (let wait = 0; wait < 300 && seen.length < 2; wait++)
  await Bun.sleep(10)
console.log(JSON.stringify(seen))
process.exit(0)`)

    expect(JSON.parse(await output(watcher))).toEqual([3, 0])
    await setter.exited
  })

  it('goes on to the next event when a watcher throws, and tells the store it replaced to stop', async () => {
    const path = await storePath()
    const store = sqliteLive(path)
    const calls: string[] = []
    let stopped = 0

    setLiveStore(store)

    const thrown = declare(0, 'test:thrown', 'thrown')
    const other = declare(0, 'test:other', 'other')

    watchSlot(liveSlot('test:thrown')!, '', () => {
      calls.push('thrown')

      throw new Error('a watcher failing')
    })
    watchSlot(liveSlot('test:other')!, '', () => calls.push('other'))

    await output(spawnProcess(path, 'live(0, \'test:thrown\', \'thrown\').set(1)\nlive(0, \'test:other\', \'other\').set(2)'))

    for (let wait = 0; wait < 300 && calls.length < 2; wait++)
      await Bun.sleep(10)

    expect(calls).toEqual(['thrown', 'other'])
    expect([thrown(), other()]).toEqual([1, 2])
    setLiveStore({ entries: () => [], set: () => undefined, delete: () => undefined, subscribe: () => undefined, stop: () => {
      stopped++
    } })
    setLiveStore(undefined)
    expect(stopped).toBe(1)
  })

  it('keeps a bounded number of rows for values nobody declared', () => {
    let hear: ((id: string, key: string, text: string | undefined) => void) | undefined

    setLiveStore({ entries: () => [], set: () => undefined, delete: () => undefined, subscribe: (listener) => {
      hear = listener
    } })
    hear!('test:evicted', '', '[1]')

    for (let row = 0; row < 10_000; row++)
      hear!('test:bulk', String(row), '[0]')

    hear!('test:recent', '', '[2]')

    expect(declare(0, 'test:evicted', 'evicted')()).toBe(0)
    expect(declare(0, 'test:recent', 'recent')()).toBe(2)
    setLiveStore(undefined)
  })

  it('keeps every row the store held at the start, however many', () => {
    const rows: [string, string, string][] = Array.from({ length: 10_500 }, (_, row) => ['test:many', String(row), '[3]'])

    setLiveStore({ entries: () => rows, set: () => undefined, delete: () => undefined, subscribe: () => undefined })

    const many = (live as unknown as (initial: (key: string) => number, id: string, name: string) => (key: string) => number)(() => 0, 'test:many', 'many')

    expect(many('0')).toBe(3)
    expect(many('10499')).toBe(3)
    setLiveStore(undefined)
  })

  it('writes to the store from a second copy of the module', async () => {
    const path = await storePath()
    const store = sqliteLive(path)
    const tag = 'second'
    const copy = await import(`../src/runtime/live-value.ts?${tag}`) as { live: typeof declare }

    setLiveStore(store)
    expect(copy.live).not.toBe(live as unknown)
    copy.live(0, 'test:copy', 'copy').set(4)
    expect(store.entries()).toEqual([['test:copy', '', '[4]']])
    setLiveStore(undefined)
  })
})
