import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

// The memory of the cgroup this process runs in, as cgroup v2 keeps it: what a session's scope has peaked at since it started, and how many of its processes the kernel killed for the limit.
export interface ScopeMemory {
  peak: number
  oomKills: number
}

const CGROUP_LINE = /^0::(.+)$/m
const OOM_KILL = /^oom_kill (\d+)$/m

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return undefined
  }
}

// None where the cgroup is not v2 or its files are unreadable.
export function scopeMemory(): ScopeMemory | undefined {
  const folder = CGROUP_LINE.exec(read('/proc/self/cgroup') ?? '')?.[1]
  const peak = folder === undefined ? undefined : read(`/sys/fs/cgroup${folder}/memory.peak`)

  if (folder === undefined || peak === undefined)
    return undefined

  return { peak: Number(peak), oomKills: Number(OOM_KILL.exec(read(`/sys/fs/cgroup${folder}/memory.events`) ?? '')?.[1] ?? 0) }
}

const MB = 1024 * 1024

// The peak and the kills count the whole scope since it started, a session's other work included, so a step names the kills it saw itself.
export function describeScope(memory: ScopeMemory | undefined, before?: ScopeMemory): string {
  if (memory === undefined)
    return 'the scope\'s memory is not readable here'

  const during = before === undefined ? '' : `, ${memory.oomKills - before.oomKills} of them during this step`

  return `the scope's memory.peak is ${Math.round(memory.peak / MB)} MB and the kernel has killed ${memory.oomKills} of its processes for the limit${during}`
}

export interface ScopeSamples {
  // The highest memory.current seen, in bytes: it counts the page cache, which the kernel gives back before it kills anything.
  peak: number
  // The highest held memory seen, in bytes: anonymous memory, tmpfs and kernel memory, which a scope without swap frees only by killing a process, so this is what has to fit the limit.
  held: number
  // Every sample as seconds since the sampler started and bytes.
  samples: [number, number, number][]
}

// The cgroup folder of this process, none where it is not v2.
function scopeFolder(): string | undefined {
  const folder = CGROUP_LINE.exec(read('/proc/self/cgroup') ?? '')?.[1]

  return folder === undefined ? undefined : `/sys/fs/cgroup${folder}`
}

const HELD_KEYS = new Set(['anon', 'shmem', 'kernel'])

// The bytes memory.stat lists as held, none where the file is unreadable. `kernel` is listed from Linux 5.19 and counts reclaimable slab too, so it is a slight overestimate.
export function heldBytes(stat: string | undefined): number | undefined {
  if (stat === undefined)
    return undefined

  let held = 0

  for (const line of stat.split('\n')) {
    const [key, value] = line.split(' ')

    if (HELD_KEYS.has(key!))
      held += Number(value)
  }

  return held
}

// Samples the scope's memory.current every `intervalMs` until `stop()`, which returns what was seen: the peak of one step, where memory.peak counts the whole scope since it started. Undefined where memory.current is not readable, so nothing runs.
// `folder` is the cgroup folder, this process's own by default.
export function sampleScope(intervalMs = 1000, folder = scopeFolder()): { stop: () => ScopeSamples } | undefined {
  const file = folder === undefined ? undefined : `${folder}/memory.current`

  if (file === undefined || read(file) === undefined)
    return undefined

  const started = performance.now()
  const samples: [number, number, number][] = []
  let peak = 0
  let held = 0

  function take() {
    const current = Number(read(file!))

    if (Number.isNaN(current))
      return

    peak = Math.max(peak, current)
    const heldNow = heldBytes(read(`${folder}/memory.stat`)) ?? 0

    held = Math.max(held, heldNow)
    samples.push([Math.round((performance.now() - started) / 100) / 10, current, heldNow])
  }

  take()
  const timer = setInterval(take, intervalMs)

  timer.unref()

  return {
    stop() {
      clearInterval(timer)
      take()

      return { peak, held, samples }
    },
  }
}

// The samples as two log lines, memory.current then the held memory: seconds then MB, in order.
export function describeSamples({ samples }: ScopeSamples): string[] {
  const series = (label: string, at: 1 | 2) => `${label} by second: ${samples.map(sample => `${sample[0]}s=${Math.round(sample[at] / MB)}`).join(' ')}`

  return [series('memory.current', 1), series('held memory', 2)]
}

const GB = 1024 * MB
// A scope this size or larger runs the suite in one run of every core's half, as a host without a limit does.
const UNCONSTRAINED = 16 * GB
// What a run holds beside its workers, and what a worker holds by the end of a shard, as `just land` measured it on a 8 GB session (a shard of the suite with 3 workers held 5.5 GB at most, 1.2 GB of it the session's own).
const RESERVED = 2 * GB
const PER_WORKER = 2 * GB

// The lowest memory limit in bytes of this process's cgroup and its parents, none where there is none (`max`) or the cgroup is not v2: a step run in a child cgroup is held by its parent's limit too.
export function scopeLimit(folder = scopeFolder(), root = '/sys/fs/cgroup'): number | undefined {
  let lowest: number | undefined

  for (let current = folder; current !== undefined && current.startsWith(root); current = current === root ? undefined : dirname(current)) {
    const limit = Number(read(`${current}/memory.max`))

    if (!Number.isNaN(limit) && limit > 0)
      lowest = Math.min(lowest ?? limit, limit)
  }

  return lowest
}

// The workers and shards a landing runs the tests with inside `limit` bytes: none where the scope is large or unlimited, so the caller keeps its own defaults. A worker keeps the global of each file that loaded a native addon (oven-sh/bun#46561), so a limited scope gets fewer workers and the suite in four runs.
export function sizeForScope(limit: number | undefined): { workers: number, shards: number } | undefined {
  if (limit === undefined || limit >= UNCONSTRAINED)
    return undefined

  return { workers: Math.max(1, Math.floor((limit - RESERVED) / PER_WORKER)), shards: 4 }
}
