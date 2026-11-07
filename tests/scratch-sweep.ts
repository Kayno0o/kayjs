import { readFileSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const AFTER_NAME = /\)\s(.*)$/s
const TICKS = 100
const BATCH = 32
const BOOT = /^btime (\d+)/m

// When a process started, in ms since the epoch: from Linux's boot time, whole seconds cut short so the answer is never later than the truth, and the start ticks of its stat line; undefined where there is no /proc.
export function startedAt(pid: number): number | undefined {
  try {
    const ticks = Number(AFTER_NAME.exec(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[1]?.split(' ')[19])
    const boot = Number(BOOT.exec(readFileSync('/proc/stat', 'utf8'))?.[1])

    return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + (ticks / TICKS) * 1000 : undefined
  }
  catch {
    return undefined
  }
}

// Removes what an earlier run left in the scratch folder: every entry last changed before `before`, so a directory made since by a worker of this run stays. The caller holds the checkout's turn, so no other run has a live one. Returns how many it removed.
export async function sweepScratch(scratch: string, before: number): Promise<number> {
  let names: string[] = []

  try {
    names = await readdir(scratch)
  }
  catch {}

  let removed = 0

  for (let index = 0; index < names.length; index += BATCH) {
    await Promise.all(names.slice(index, index + BATCH).map(async (name) => {
      const path = join(scratch, name)

      try {
        const info = await stat(path)

        if (info.mtimeMs < before && info.ctimeMs < before) {
          await rm(path, { recursive: true, force: true })
          removed++
        }
      }
      catch {}
    }))
  }

  return removed
}
