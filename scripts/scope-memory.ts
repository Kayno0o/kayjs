import { readFileSync } from 'node:fs'

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
  // The highest memory.current seen, in bytes.
  peak: number
  // Every sample as seconds since the sampler started and bytes.
  samples: [number, number][]
}

// The cgroup folder of this process, none where it is not v2.
function scopeFolder(): string | undefined {
  const folder = CGROUP_LINE.exec(read('/proc/self/cgroup') ?? '')?.[1]

  return folder === undefined ? undefined : `/sys/fs/cgroup${folder}`
}

// Samples the scope's memory.current every `intervalMs` until `stop()`, which returns what was seen: the peak of one step, where memory.peak counts the whole scope since it started. Undefined where memory.current is not readable, so nothing runs.
// `folder` is the cgroup folder, this process's own by default.
export function sampleScope(intervalMs = 1000, folder = scopeFolder()): { stop: () => ScopeSamples } | undefined {
  const file = folder === undefined ? undefined : `${folder}/memory.current`

  if (file === undefined || read(file) === undefined)
    return undefined

  const started = performance.now()
  const samples: [number, number][] = []
  let peak = 0

  function take() {
    const current = Number(read(file!))

    if (Number.isNaN(current))
      return

    peak = Math.max(peak, current)
    samples.push([Math.round((performance.now() - started) / 100) / 10, current])
  }

  take()
  const timer = setInterval(take, intervalMs)

  timer.unref()

  return {
    stop() {
      clearInterval(timer)
      take()

      return { peak, samples }
    },
  }
}

// The samples as a log line: seconds then MB, in order.
export function describeSamples({ samples }: ScopeSamples): string {
  return `memory.current by second: ${samples.map(([at, bytes]) => `${at}s=${Math.round(bytes / MB)}`).join(' ')}`
}
