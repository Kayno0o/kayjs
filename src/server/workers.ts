import type { AppStore } from './app-store'
import { rm } from 'node:fs/promises'
import { availableParallelism, constants } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { kayLog } from '../runtime/log'
import { isInMemory } from './memory-mark'
import { START_PARENT, WORKER_COUNT, WORKER_INDEX } from './parent'

// The server runs in a process group of its own, so each of these reaches it once, through the primary, whether a terminal sent it to the group or a supervisor to the primary alone.
export const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const
// The signals asking a server to stop: dying of one the primary passed on is a stop, not a failure.
export const STOPS = new Set<string>(['SIGINT', 'SIGTERM', 'SIGHUP'])

export const MAX_WORKERS = 256
const WHOLE_NUMBER = /^\d+$/
const FIRST_BACKOFF_MS = 250
// A worker living this long has booted: its next death starts the backoff over.
const HEALTHY_MS = 10_000
// Deaths in a row, none of them past HEALTHY_MS, after which the app is taken for one that cannot boot.
const CRASH_LIMIT = 5
// Where the workers keep what the app's `store` leaves in memory.
const SHARED_PATH = 'data/workers.sqlite'
const SHARING = Symbol.for('kay.sharingThePort')

// The count `--workers` or `KAY_WORKERS` asks for: a whole number from 1, or `auto` for one per core.
export function parseWorkers(value: string): number | undefined {
  if (value === 'auto')
    return availableParallelism()

  const count = Number(value)

  return WHOLE_NUMBER.test(value) && count >= 1 && count <= MAX_WORKERS ? count : undefined
}

// The count an executable run by hand asks for, by `--workers <n|auto>` over `KAY_WORKERS`; undefined when it asks none, and an invalid value throws.
export function requestedWorkers(argv: string[], env: Record<string, string | undefined>): number | undefined {
  const at = argv.findIndex(arg => arg === '--workers' || arg.startsWith('--workers='))

  if (at === -1 && (env[WORKER_COUNT] ?? '') === '')
    return undefined

  const value = at === -1 ? env[WORKER_COUNT]! : flagValue(argv, at)

  const count = parseWorkers(value)

  if (count === undefined)
    throw new Error(`--workers takes a number from 1 to ${MAX_WORKERS}, or auto, not ${value}`)

  return count
}

// Whether this process is one worker of several, which `kay start` or the executable's own primary made.
export function workerCount(): number {
  return isWorker() ? Number(process.env[WORKER_COUNT]) || 1 : 1
}

export function isWorker(): boolean {
  return process.env[WORKER_INDEX] !== undefined
}

// A worker listens through `reusePort`, whatever calls `Bun.serve`: `listen` of an entry, or kay's own. A server on a unix socket has no port to share.
export function shareThePort(): void {
  if (!isWorker() || Reflect.get(Bun, SHARING) === true)
    return

  const serve = Bun.serve.bind(Bun)

  Reflect.set(Bun, SHARING, true)
  Bun.serve = ((options: Record<string, unknown>) => serve((options.unix === undefined ? { ...options, reusePort: true } : options) as unknown as Parameters<typeof Bun.serve>[0])) as unknown as typeof Bun.serve
}

// What the app's `store` leaves out and one process would keep in its memory, kept in a SQLite file the workers share; a store the app names is left as it is.
export async function sharedStores(store: AppStore | undefined): Promise<AppStore | undefined> {
  if (workerCount() < 2)
    return store

  warnOfMemoryStores(store)

  const { sqliteData } = await import('./sqlite-data')
  const { cache, live, rates, rooms, vitals, notifications, push } = sqliteData(SHARED_PATH)

  return { ...store, cache: store?.cache ?? cache, live: store?.live ?? live, rates: store?.rates ?? rates, rooms: store?.rooms ?? rooms, vitals: store?.vitals ?? vitals, notifications: store?.notifications ?? notifications, push: store?.push ?? push }
}

// `reusePort` balances connections between processes on Linux only; elsewhere one worker serves, as without the flag.
export function platformWorkers(asked: number, name: string): number {
  if (asked > 1 && process.platform !== 'linux') {
    console.warn(`${name}: --workers needs reusePort, which ${process.platform} does not balance between processes; serving from one worker`)

    return 1
  }

  return asked
}

// What the executable's generated entry runs before it imports anything: with `--workers` or `KAY_WORKERS` asking for several, it is the primary, running itself as each worker, and returns the exit code; undefined for a process that serves.
export async function runAsPrimary(argv: string[], env: Record<string, string | undefined>): Promise<number | undefined> {
  // `--health` and `--load` ask a process of their own, whatever the environment says.
  if (env[WORKER_INDEX] !== undefined || argv.includes('--health') || argv.includes('--load'))
    return undefined

  let asked: number | undefined

  try {
    asked = requestedWorkers(argv, env)
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))

    return 1
  }

  const count = platformWorkers(asked ?? 1, basename(process.execPath))

  return count < 2 ? undefined : superviseWorkers({ command: [process.execPath, ...argv.slice(2)], cwd: process.cwd(), env, count, name: basename(process.execPath) })
}

// The factories of the stores that keep their data in one process's memory, by the `store` key an app puts them under.
const MEMORY_FACTORIES = { sessions: 'memoryStore', jobs: 'memoryJobs', rates: 'memoryRates', rooms: 'memoryRooms', vitals: 'memoryVitals', notifications: 'memoryNotifications', push: 'memoryPush' } as const

// A store the app built in memory is kept, and splits per worker: said once, by the first worker.
function warnOfMemoryStores(store: AppStore | undefined): void {
  if (process.env[WORKER_INDEX] !== '0' || store === undefined)
    return

  for (const [kind, factory] of Object.entries(MEMORY_FACTORIES)) {
    if (isInMemory(store[kind as keyof typeof MEMORY_FACTORIES]))
      kayLog('warn', `store.${kind} is ${factory}(), which each of the ${workerCount()} workers keeps to itself: name sqliteData('data/app.sqlite') or a store of your own shared between processes for it in kay.config.ts`)
  }
}

interface Supervised {
  // What runs one worker.
  command: string[]
  cwd: string
  env: Record<string, string | undefined>
  count: number
  // Which program says so in its messages.
  name: string
}

interface Slot {
  process: Bun.Subprocess | undefined
  startedAt: number
  deaths: number
}

// Runs `count` workers on the one port, restarts one that dies unasked, passes a stop on to all and waits for them to drain. Returns the exit code of the primary.
export async function superviseWorkers({ command, cwd, env, count, name }: Supervised): Promise<number> {
  // A throwaway server asked for a key of its process; the workers would each make their own and refuse each other's stamps, so they share one made here.
  const shared = env.KAY_EPHEMERAL_SECRET === '1' && (env.KAY_SECRET === undefined || env.KAY_SECRET === '') ? { KAY_SECRET: crypto.randomUUID() + crypto.randomUUID() } : {}

  // The file the workers share starts empty: what a run kept in memory on one process does not outlive it.
  await Promise.all(['', '-wal', '-shm'].map(async suffix => rm(join(cwd, `${SHARED_PATH}${suffix}`), { force: true })))

  const forwarded = new Set<string>()
  const workers: Slot[] = Array.from({ length: count }, () => ({ process: undefined, startedAt: 0, deaths: 0 }))
  const codes: number[] = []
  let stopping = false
  let failed = false
  let wake: () => void = () => undefined
  const woken = new Promise<void>((resolve) => {
    wake = resolve
  })

  const stopAll = (signal: NodeJS.Signals) => {
    for (const worker of workers)
      worker.process?.kill(signal)
  }

  // Taken before any worker starts: a Ctrl-C to the group landing as they boot would otherwise end the primary alone.
  for (const signal of FORWARDED) {
    process.on(signal, () => {
      forwarded.add(signal)
      stopping = true
      wake()
      stopAll(signal)
    })
  }

  const run = async (index: number): Promise<void> => {
    const worker = workers[index]!

    while (!stopping) {
      worker.startedAt = Date.now()

      try {
        worker.process = Bun.spawn(command, { cwd, env: { ...env, ...shared, [START_PARENT]: String(process.pid), [WORKER_INDEX]: String(index), [WORKER_COUNT]: String(count) }, stdio: ['inherit', 'inherit', 'inherit'], detached: true })
      }
      catch (error) {
        console.error(`${name}: cannot run ${command.at(-1)}: ${error instanceof Error ? error.message : String(error)}`)
        failed = true
        stopping = true
        wake()
        stopAll('SIGTERM')

        return
      }

      const code = await worker.process.exited
      const { signalCode } = worker.process

      worker.process = undefined

      if (stopping) {
        codes.push(exitCode(code, signalCode, forwarded))

        return
      }

      worker.deaths = Date.now() - worker.startedAt >= HEALTHY_MS ? 1 : worker.deaths + 1

      if (worker.deaths >= CRASH_LIMIT) {
        console.error(`${name}: worker ${index} died ${CRASH_LIMIT} times in a row without staying up; the app does not boot, stopping`)
        failed = true
        stopping = true
        wake()
        stopAll('SIGTERM')

        return
      }

      const wait = FIRST_BACKOFF_MS * 2 ** (worker.deaths - 1)

      console.error(`${name}: worker ${index} ${signalCode === null ? `exited with ${code}` : `was killed by ${signalCode}`}; restarting in ${wait} ms`)
      await Promise.race([Bun.sleep(wait), woken])
    }
  }

  await Promise.all(workers.map(async (_, index) => run(index)))

  return failed ? 1 : codes.find(code => code !== 0) ?? 0
}

// As a shell reports a process a signal ended, one with no name coming as its number.
export function exitCode(code: number | null, signalCode: NodeJS.Signals | number | null, forwarded: Set<string>): number {
  if (signalCode === null)
    return code ?? 0

  if (typeof signalCode === 'number')
    return 128 + signalCode

  return STOPS.has(signalCode) && forwarded.has(signalCode) ? 0 : 128 + constants.signals[signalCode]
}

// The value of `--workers` at `at`: after an equals sign, else the next argument, empty when there is none.
function flagValue(argv: string[], at: number): string {
  const given = argv[at]!

  return given.startsWith('--workers=') ? given.slice('--workers='.length) : argv[at + 1] ?? ''
}
