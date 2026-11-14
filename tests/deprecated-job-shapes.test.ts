import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { diskFilesCalls, jobHandlers, jobOptions, scheduleCalls } from '../src/check/job-shapes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('job-shapes-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function fixed(source: string, check: typeof jobHandlers): Promise<{ text: string, found: Awaited<ReturnType<typeof jobHandlers>> }> {
  const root = await project({ 'src/jobs/a.ts': source })

  try {
    const found = await check(root, {})

    await applySafeFixes(root, found)

    return { text: await Bun.file(join(root, 'src/jobs/a.ts')).text(), found }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

const IMPORT = 'import { background, diskFiles, queue, schedule, workflow } from \'kay/server\'\n'

describe('deprecated-job-handler', () => {
  it('destructures the signal and the job of a queue handler off its context', async () => {
    const { text, found } = await fixed(`${IMPORT}
export const a = queue('a', async (to: string, signal) => fetch(to, { signal }))
export const b = queue('b', (_payload, signal: AbortSignal, job) => job.progress(signal.aborted))
export const c = queue('c', function (_payload, abort, info) { return [abort, info] })
export const d = queue('d', (payload, { signal }) => [payload, signal])
export const e = queue('e', (payload, ctx) => ctx.signal)
export const f = queue('f', (_payload, signal, job: JobContext<number>) => [signal, job])
export const g = queue('g', handler)
`, jobHandlers)

    expect(found.map(one => one.fixes?.[0]?.safe ?? null)).toEqual([true, true, true, null])
    expect(text).toBe(`${IMPORT}
export const a = queue('a', async (to: string, { signal }) => fetch(to, { signal }))
export const b = queue('b', (_payload, { signal, job }) => job.progress(signal.aborted))
export const c = queue('c', function (_payload, { signal: abort, job: info }) { return [abort, info] })
export const d = queue('d', (payload, { signal }) => [payload, signal])
export const e = queue('e', (payload, ctx) => ctx.signal)
export const f = queue('f', (_payload, signal, job: JobContext<number>) => [signal, job])
export const g = queue('g', handler)
`)
  })

  it('moves the run of a workflow, its id and its steps, off the single object it took', async () => {
    const { text, found } = await fixed(`${IMPORT}
export const a = workflow('a', async ({ step }) => { await step.sleep('1h') })
export const b = workflow<{ to: string }>('b', async ({ input, step }) => { await step.run('x', () => input.to) })
export const c = workflow('c', async ({ id, input: who, step: s }) => { await s.sleep(id + who) })
export const d = workflow('d', async ({ id, input }) => [id, input])
export const e = workflow('e', async ({ input, ...rest }) => [input, rest])
export const f = workflow('f', async (input, { step }) => [input, step])
`, jobHandlers)

    expect(found.map(one => one.fixes?.[0]?.safe ?? null)).toEqual([true, true, true, true, null])
    expect(text).toBe(`${IMPORT}
export const a = workflow('a', async (_input, { step }) => { await step.sleep('1h') })
export const b = workflow<{ to: string }>('b', async (input, { step }) => { await step.run('x', () => input.to) })
export const c = workflow('c', async (who, { step: s, job: { id } }) => { await s.sleep(id + who) })
export const d = workflow('d', async (input, { job: { id } }) => [id, input])
export const e = workflow('e', async ({ input, ...rest }) => [input, rest])
export const f = workflow('f', async (input, { step }) => [input, step])
`)
  })

  it('moves the signal of a scheduled or background job to the context, past the run it is given first', async () => {
    const { text } = await fixed(`${IMPORT}
export const a = schedule('@hourly', async signal => fetch('x', { signal }))
export const b = schedule({ cron: '@hourly' }, [(abort: AbortSignal) => abort, () => 1])
export const c = schedule({ '@daily': (signal) => signal, '30s': [async (signal) => signal] })
export const d = background(async (signal) => signal)
export const e = background(async (_, { signal }) => signal)
export const f = background(() => 1)
export const g = schedule({ every: '1m' }, (run) => run)
`, jobHandlers)

    expect(text).toBe(`${IMPORT}
export const a = schedule('@hourly', async (_, { signal }) => fetch('x', { signal }))
export const b = schedule({ cron: '@hourly' }, [(_, { signal: abort }) => abort, () => 1])
export const c = schedule({ '@daily': (_, { signal }) => signal, '30s': [async (_, { signal }) => signal] })
export const d = background(async (_, { signal }) => signal)
export const e = background(async (_, { signal }) => signal)
export const f = background(() => 1)
export const g = schedule({ every: '1m' }, (run) => run)
`)
  })

  it('reports a handler it cannot rewrite safely, and one that holds a comment, with no fix, and one with a default value alone', async () => {
    const { found } = await fixed(`${IMPORT}
export const a = queue('a', (payload, signal = new AbortController().signal) => [payload, signal])
export const b = workflow('b', async ({ input }: { input: string }) => input)
export const c = queue('c', (payload, signal /* the run's */, job) => [payload, signal, job])
`, jobHandlers)

    expect(found.map(one => one.fixes)).toEqual([undefined, undefined])
  })

  it('leaves a handler of the new shape alone, annotated or not, and one using the name the fix would add', async () => {
    const { found, text } = await fixed(`${IMPORT}
export const a = queue('a', (payload: string, ctx: JobContext) => [payload, ctx])
export const b = schedule({ every: '1m' }, (run: ScheduleRun) => run)
export const c = background(async (_input: undefined, ctx: JobContext) => ctx)
export const d = background(async (signal) => _.debounce(signal))
`, jobHandlers)

    expect(found.map(one => one.fixes)).toEqual([undefined])
    expect(text).toContain('background(async (signal) => _.debounce(signal))')
  })

  it('leaves a function that is not imported from kay/server alone', async () => {
    const { found } = await fixed('import { queue } from \'./mine\'\n\nexport const a = queue(\'a\', (payload, signal) => [payload, signal])\n', jobHandlers)

    expect(found).toHaveLength(0)
  })
})

describe('deprecated-schedule-call', () => {
  it('writes the schedule and its options as one object', async () => {
    const { text, found } = await fixed(`${IMPORT}
export const a = schedule('@hourly', sweep)
export const b = schedule('30 2 * * MON', sweep, { timeZone: 'Europe/Paris', lock: 'sweep' })
export const c = schedule('30s', [warm, sweep], options)
export const d = schedule(90, warm, { boot: true })
export const e = schedule({ cron: '@hourly' }, sweep)
export const f = schedule({ '@hourly': sweep }, { lock: false })
export const g = schedule('@daily', sweep, { lock: 'x' /* the one daily */ })
`, scheduleCalls)

    expect(found.map(one => one.fixes?.[0]?.safe ?? null)).toEqual([true, true, true, true, null])
    expect(text).toBe(`${IMPORT}
export const a = schedule({ cron: '@hourly' }, sweep)
export const b = schedule({ cron: '30 2 * * MON', timeZone: 'Europe/Paris', lock: 'sweep' }, sweep)
export const c = schedule({ every: '30s', ...options }, [warm, sweep])
export const d = schedule({ every: 90, boot: true }, warm)
export const e = schedule({ cron: '@hourly' }, sweep)
export const f = schedule({ '@hourly': sweep }, { lock: false })
export const g = schedule('@daily', sweep, { lock: 'x' /* the one daily */ })
`)
  })
})

describe('deprecated-job-options', () => {
  it('renames lostAfter to timeout in the options of a queue or a workflow', async () => {
    const { text, found } = await fixed(`${IMPORT}
export const a = queue('a', run, { attempts: 2, lostAfter: '5m' })
export const b = workflow('b', flow, { lostAfter: '1m' })
export const c = queue('c', run, { lostAfter: '5m', timeout: '1m' })
export const d = queue('d', run, { timeout: '5m' })
`, jobOptions)

    expect(found.map(one => one.fixes?.[0]?.safe ?? null)).toEqual([true, true, null])
    expect(text).toContain('queue(\'a\', run, { attempts: 2, timeout: \'5m\' })')
    expect(text).toContain('workflow(\'b\', flow, { timeout: \'1m\' })')
    expect(text).toContain('{ lostAfter: \'5m\', timeout: \'1m\' }')
  })
})

describe('deprecated-disk-files', () => {
  it('writes the directory and the hooks of a disk store as one object', async () => {
    const { text, found } = await fixed(`${IMPORT}
export const a = diskFiles('data/uploads')
export const b = diskFiles(dir, { onWrite: audit, onDelete })
export const c = diskFiles(dir, hooks)
export const d = diskFiles()
export const e = diskFiles({ dir: 'x' })
`, diskFilesCalls)

    expect(found).toHaveLength(3)
    const other = await fixed(`${IMPORT}\nconst options = { dir: 'x' }\nexport const a = diskFiles(options)\nexport const b = diskFiles('x')\n`, diskFilesCalls)

    expect(other.found).toHaveLength(1)
    expect(text).toBe(`${IMPORT}
export const a = diskFiles({ dir: 'data/uploads' })
export const b = diskFiles({ dir: dir, onWrite: audit, onDelete })
export const c = diskFiles({ dir: dir, ...hooks })
export const d = diskFiles()
export const e = diskFiles({ dir: 'x' })
`)
  })
})
