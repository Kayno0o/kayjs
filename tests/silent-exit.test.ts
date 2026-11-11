import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { parseEvents } from '../scripts/scope-memory'
import { describeSilentExit, junitFiles, reportedFiles } from '../scripts/silent-exit'

import { scratchDir } from './scratch'

const MB = 1024 * 1024
const before = { peak: 0, oomKills: 0, max: 3, oom: 0 }
const after = { peak: 0, oomKills: 0, max: 41, oom: 1 }
const lines = ['bun test v1.4.4', '', ' 2392 pass', ' 0 fail', 'Ran 2392 tests across 118 files. [301.00s]']
const listed = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts']

describe('a test shard that exits nonzero with no failed test', () => {
  it('says so in one line: the held memory, the events, the files that never reported and the retry advice', () => {
    const text = describeSilentExit({ exitCode: 1, lines, held: 7800 * MB, limit: 8192 * MB, before, after, listed, reported: ['tests/a.test.ts'] })

    expect(text).toBe('exit 1 with no failed test: 7800 MB held against the 8192 MB cap; memory.events max 3 -> 41, oom 0 -> 1, oom_kill 0 -> 0; 2 of 3 files did not report a result: tests/b.test.ts, tests/c.test.ts. It ran within 10% of the cap, so a worker most likely died under memory pressure: run it again with nothing beside it, or with KAY_LAND_WORKERS lowered.')
    expect(text).not.toContain('\n')
  })

  it('gives no retry advice while the memory held stayed under 90% of the cap', () => {
    const text = describeSilentExit({ exitCode: 1, lines, held: 5000 * MB, limit: 8192 * MB, before, after, listed, reported: listed })

    expect(text).toContain('every file of the shard reported a result')
    expect(text).not.toContain('KAY_LAND_WORKERS')
  })

  it('says what it does not know', () => {
    const text = describeSilentExit({ exitCode: 1, lines, held: undefined, limit: undefined, before: undefined, after: undefined, listed: [], reported: [] })

    expect(text).toBe('exit 1 with no failed test: the held memory is not known; the scope\'s memory.events is not readable here; the shard\'s files are not known.')
  })

  it('blames no file when the run wrote no report', () => {
    const text = describeSilentExit({ exitCode: 1, lines, held: 1, limit: 2, before, after, listed, reported: [] })

    expect(text).toContain('no report was written, so which of the shard\'s 3 files ran is not known')
    expect(text).not.toContain('did not report')
  })

  it('leaves a run that names its cause alone', () => {
    const input = { exitCode: 1, held: 1, limit: 2, before, after, listed, reported: [] }

    expect(describeSilentExit({ ...input, lines: ['(fail) a test'] })).toBeUndefined()
    expect(describeSilentExit({ ...input, lines: ['✗ tests/a.test.ts (worker crashed: SIGKILL)'] })).toBeUndefined()
    expect(describeSilentExit({ ...input, exitCode: 0, lines })).toBeUndefined()
  })

  it('caps the files it names', () => {
    const many = Array.from({ length: 13 }, (_, index) => `tests/f${index}.test.ts`)

    expect(describeSilentExit({ exitCode: 1, lines, held: 1, limit: 2, before, after, listed: many, reported: ['tests/other.test.ts'] })).toContain(', and 3 more')
  })
})

describe('what a shard reports', () => {
  it('lists the files of a junit report once', () => {
    const xml = '<testsuites><testsuite name="tests/a.test.ts" file="tests/a.test.ts" tests="1"><testsuite name="a" file="tests/a.test.ts" line="3"></testsuite></testsuite><testsuite name="tests/b.test.ts" file="tests/b.test.ts"></testsuite></testsuites>'

    expect(junitFiles(xml)).toEqual(['tests/a.test.ts', 'tests/b.test.ts'])
  })

  it('reads a junit file from disk, and none where it was not written', async () => {
    const dir = await scratchDir('silent-exit-')
    const file = join(dir, 'report.xml')

    await Bun.write(file, '<testsuites><testsuite name="a" file="tests/a.test.ts"></testsuite></testsuites>')
    expect(await reportedFiles(file)).toEqual(['tests/a.test.ts'])
    expect(await reportedFiles(join(dir, 'missing.xml'))).toEqual([])
  })

  it('reads the counters of memory.events', () => {
    expect(parseEvents('low 0\nhigh 0\nmax 41\noom 1\noom_kill 2\noom_group_kill 0\n')).toEqual({ max: 41, oom: 1, oomKills: 2 })
    expect(parseEvents('')).toEqual({ max: 0, oom: 0, oomKills: 0 })
  })
})
