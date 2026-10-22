import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { live, liveSlot, setLiveStore, watchSlot } from '../src/runtime/live-value'
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
})
