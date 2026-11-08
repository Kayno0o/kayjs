import { readdirSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { afterAll, beforeAll } from 'bun:test'
import { kill } from './alive'

// A test file that leaves a process it started running, at any depth and even a detached one, fails: nothing else notices a leaked server until someone reads `ps`.
// Every test process adds its own id to this variable, which its children inherit, so a process carrying our id is ours and never another run's, nor another worker's.
const MARK = 'KAY_TEST_PROCESSES'
const GRACE = 3000
const AFTER_NAME = /\)\s(.*)$/s
const ID = String(process.pid)

interface Found {
  pid: number
  start: string
  command: string
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return undefined
  }
}

interface Stat {
  parent: number
  // In clock ticks since boot, telling a process from a later one given the same pid.
  start: number
  // A zombie (`Z`) or a dead one (`X`) has ended, though `process.kill(pid, 0)` still reaches it.
  ended: boolean
}

function stat(pid: number): Stat | undefined {
  const fields = AFTER_NAME.exec(read(`/proc/${pid}/stat`) ?? '')?.[1]?.split(' ')

  return fields ? { parent: Number(fields[1]), start: Number(fields[19]), ended: fields[0] === 'Z' || fields[0] === 'X' } : undefined
}

// A process is ours when it descends from us by parents, or when it carries our id, which holds for one orphaned since it started.
function descends(pid: number, stats: Map<number, Stat>): boolean {
  for (let current = pid, depth = 0; current > 1 && depth < 64; depth++) {
    const parent = stats.get(current)?.parent

    if (parent === undefined)
      return false

    if (parent === process.pid)
      return true

    current = parent
  }

  return false
}

function marked(pid: number): boolean {
  const marks = read(`/proc/${pid}/environ`)?.split('\0').find(entry => entry.startsWith(`${MARK}=`))

  return marks?.slice(MARK.length + 1).split(',').includes(ID) ?? false
}

// One pass reads every process's stat; only one started after us can be ours, so the host's older processes cost no other read.
function running(): Found[] {
  const stats = new Map<number, Stat>()

  for (const name of readdirSync('/proc')) {
    const pid = Number(name)
    const found = Number.isInteger(pid) ? stat(pid) : undefined

    if (found)
      stats.set(pid, found)
  }

  const since = stats.get(process.pid)?.start ?? 0
  const found: Found[] = []

  for (const [pid, { start, ended }] of stats) {
    if (pid === process.pid || ended || start < since || !(descends(pid, stats) || marked(pid)))
      continue

    found.push({ pid, start: String(start), command: (read(`/proc/${pid}/cmdline`) ?? '').split('\0').join(' ').trim().slice(0, 300) })
  }

  return found
}

// `Bun.spawn` hands its child the environment the process started with, not what the run set since, so the id is added to each call, whatever env it passes, and a call with no env gets a copy of the environment taken when the preload first loads, as without it.
function markedSpawn<T>(spawn: T): T {
  if (Reflect.get(spawn as object, MARK) === true)
    return spawn

  const call = spawn as unknown as (...args: unknown[]) => unknown
  const started = { ...process.env }

  // Either `(command, options)` or `(options)` with the command inside.
  const wrapped = (first: unknown, second?: { env?: object }) => {
    const withEnv = (options?: { env?: object }) => ({ ...options, env: { ...(options?.env ?? started), [MARK]: process.env[MARK] } })

    return Array.isArray(first)
      ? call(first, withEnv(second))
      : call(withEnv(first as { env?: object }))
  }

  Reflect.set(wrapped, MARK, true)

  return wrapped as unknown as T
}

const hasProc = readdirSync('/', { withFileTypes: true }).some(entry => entry.name === 'proc' && entry.isDirectory())

if (hasProc) {
  process.env[MARK] = [process.env[MARK], ID].filter(Boolean).join(',')
  Bun.spawn = markedSpawn(Bun.spawn)
  Bun.spawnSync = markedSpawn(Bun.spawnSync)

  // What an earlier file of this process left was reported then, so only what appears while this file runs counts.
  let before = new Set<string>()

  beforeAll(() => {
    before = new Set(running().map(({ pid, start }) => `${pid} ${start}`))
  })

  afterAll(async () => {
    const deadline = Date.now() + GRACE
    let leaked: Found[] = []

    // A child asked to stop, a browser closing and a zombie not reaped yet are still exiting for a moment.
    do {
      leaked = running().filter(({ pid, start }) => !before.has(`${pid} ${start}`))

      if (leaked.length === 0)
        return

      await Bun.sleep(100)
    } while (Date.now() < deadline)

    for (const { pid } of leaked)
      kill(pid)

    const list = leaked.map(({ pid, command }) => `  ${pid} ${command}`).join('\n')

    throw new Error(`this file left ${leaked.length} process${leaked.length === 1 ? '' : 'es'} running (killed now):\n${list}`)
  })
}
