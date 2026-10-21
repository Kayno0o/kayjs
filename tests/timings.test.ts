import { join } from 'node:path'
import { Glob } from 'bun'
import { describe, expect, it } from 'bun:test'
import { MARKER, measurementOf, merge, UNMEASURED_MS } from '../scripts/timings'

describe('the timings the suite schedules by', () => {
  it('lists every test file in the committed file', async () => {
    const committed = (await Bun.file(join(import.meta.dir, 'timings.json')).json() as { files: Record<string, number> }).files
    const onDisk = await Array.fromAsync(new Glob('tests/**/*.test.{ts,tsx,js,jsx}').scan({ cwd: join(import.meta.dir, '..') }))

    expect(onDisk.filter(file => !(file in committed))).toEqual([])
    expect(Object.keys(committed).filter(file => !onDisk.includes(file))).toEqual([])
  })

  it('gives a file with no measurement an early start, and drops a file gone from disk', () => {
    expect(merge({ 'tests/a.test.ts': 5, 'tests/gone.test.ts': 9 }, ['tests/a.test.ts', 'tests/new.test.ts'])).toEqual({ 'tests/a.test.ts': 5, 'tests/new.test.ts': UNMEASURED_MS })
  })

  it('reads the last measurement a run printed, through the log\'s timestamps', () => {
    const log = [
      '2026-10-21T17:41:13.3Z 12s tests/a.test.ts',
      `2026-10-21T17:41:13.4Z ${MARKER}${JSON.stringify({ version: 1, files: { 'tests/a.test.ts': 12_000 } })}`,
      '2026-10-21T17:41:13.5Z done',
    ].join('\n')

    expect(measurementOf(log)).toEqual({ 'tests/a.test.ts': 12_000 })
    expect(measurementOf('2026-10-21T17:41:13.3Z 12s tests/a.test.ts')).toBeUndefined()
  })
})
