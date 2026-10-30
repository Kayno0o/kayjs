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

export function describeScope(memory: ScopeMemory | undefined): string {
  return memory === undefined ? 'the scope\'s memory is not readable here' : `the scope's memory.peak is ${Math.round(memory.peak / MB)} MB and the kernel has killed ${memory.oomKills} of its processes for the limit`
}
