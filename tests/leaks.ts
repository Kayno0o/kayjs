import { readdirSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { afterAll, beforeAll } from 'bun:test'
import { alive, kill } from './alive'

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

// The parent and the start time of a process, the start time telling it from a process that was given the same pid later.
function stat(pid: number): { parent: number, start: string } | undefined {
  const fields = AFTER_NAME.exec(read(`/proc/${pid}/stat`) ?? '')?.[1]?.split(' ')

  return fields ? { parent: Number(fields[1]), start: fields[19] ?? '' } : undefined
}

// A process is ours when it carries our id, or when it descends from us by parents, which holds for one started without our environment until it is orphaned.
function descends(pid: number): boolean {
  for (let current = pid, depth = 0; current > 1 && depth < 64; depth++) {
    const parent = stat(current)?.parent

    if (parent === undefined)
      return false

    if (parent === process.pid)
      return true

    current = parent
  }

  return false
}

function ours(pid: number): boolean {
  const marks = read(`/proc/${pid}/environ`)?.split('\0').find(entry => entry.startsWith(`${MARK}=`))

  return marks?.slice(MARK.length + 1).split(',').includes(ID) || descends(pid)
}

function running(): Found[] {
  const found: Found[] = []

  for (const name of readdirSync('/proc')) {
    const pid = Number(name)

    if (!Number.isInteger(pid) || pid === process.pid || !alive(pid) || !ours(pid))
      continue

    const start = stat(pid)?.start

    if (start !== undefined)
      found.push({ pid, start, command: (read(`/proc/${pid}/cmdline`) ?? '').split('\0').join(' ').trim().slice(0, 300) })
  }

  return found
}

// `Bun.spawn` hands its child the environment the process started with, not what the run set since, so the id is added to each call, whatever env it passes.
function marked<T>(spawn: T): T {
  if (Reflect.get(spawn as object, MARK) === true)
    return spawn

  const call = spawn as unknown as (...args: unknown[]) => unknown

  // Either `(command, options)` or `(options)` with the command inside.
  const wrapped = (first: unknown, second?: { env?: object }) => {
    const withEnv = (options?: { env?: object }) => ({ ...options, env: { ...(options?.env ?? process.env), [MARK]: process.env[MARK] } })

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
  Bun.spawn = marked(Bun.spawn)
  Bun.spawnSync = marked(Bun.spawnSync)

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
