import type { ScopeMemory } from './scope-memory'

const MB = 1024 * 1024
const FILE = /<testsuite [^>]*\bfile="([^"]+)"/g
// Held memory this close to the cap leaves a worker one allocation from the kernel's kill.
const NEAR = 0.9
const SHOWN = 10

// The test files a junit report lists, which are the files that reported a result.
export function junitFiles(xml: string): string[] {
  return [...new Set([...xml.matchAll(FILE)].map(found => found[1]!))]
}

// The files a junit report written to `path` lists, none where there is no such file.
export async function reportedFiles(path: string): Promise<string[]> {
  try {
    return junitFiles(await Bun.file(path).text())
  }
  catch {
    return []
  }
}

export interface SilentExit {
  exitCode: number
  // The step's output lines: one with a `(fail)` line or a worker crash line has its own cause.
  lines: string[]
  // The most memory held (anon, tmpfs and kernel) the step sampled, and the scope's limit, both in bytes.
  held: number | undefined
  limit: number | undefined
  before: ScopeMemory | undefined
  after: ScopeMemory | undefined
  // The files the shard runs and those that reported a result.
  listed: string[]
  reported: string[]
}

function counters(memory: ScopeMemory | undefined, before: ScopeMemory | undefined): string {
  if (memory === undefined)
    return 'the scope\'s memory.events is not readable here'

  const change = (key: 'max' | 'oom' | 'oomKills') => `${before?.[key] ?? 0} -> ${memory[key]}`

  return `memory.events max ${change('max')}, oom ${change('oom')}, oom_kill ${change('oomKills')}`
}

// What the files of the shard that gave no result come to.
function unreported(listed: string[], reported: string[], missing: string[]): string {
  if (listed.length === 0)
    return 'the shard\'s files are not known'

  // The report is written when a run ends, so a run that died as a whole leaves none: that blames no file.
  if (reported.length === 0)
    return `no report was written, so which of the shard's ${listed.length} files ran is not known`

  if (missing.length === 0)
    return 'every file of the shard reported a result'

  return `${missing.length} of ${listed.length} files did not report a result: ${missing.slice(0, SHOWN).join(', ')}${missing.length > SHOWN ? `, and ${missing.length - SHOWN} more` : ''}`
}

// One paragraph for a test step that exited nonzero with no failed test and no named crash: the held memory against the cap, the scope's events before and after, the files that never reported, and what to try. Undefined when the output already says why.
export function describeSilentExit({ exitCode, lines, held, limit, before, after, listed, reported }: SilentExit): string | undefined {
  if (exitCode === 0 || lines.some(line => line.startsWith('(fail) ') || line.includes('(worker crashed')))
    return undefined

  const memory = held === undefined || limit === undefined ? 'the held memory is not known' : `${Math.round(held / MB)} MB held against the ${Math.round(limit / MB)} MB cap`
  const missing = listed.filter(file => !reported.includes(file))
  const files = unreported(listed, reported, missing)
  const near = held !== undefined && limit !== undefined && held >= limit * NEAR
  const advice = near ? ' It ran within 10% of the cap, so a worker most likely died under memory pressure: run it again with nothing beside it, or with KAY_LAND_WORKERS lowered.' : ''

  return `exit ${exitCode} with no failed test: ${memory}; ${counters(after, before)}; ${files}.${advice}`
}
