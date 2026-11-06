import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { unmountedJobs } from '../src/check/unmounted-jobs'
import { scratchDir } from './scratch'

const queues = 'import { queue } from \'kay/server\'\nexport const welcomeMails = queue(\'welcome-mails\', async () => {})\n'

async function project(files: Record<string, string>): Promise<string> {
  const dir = await scratchDir('unmounted-jobs-')

  for (const [name, source] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), source)
  }

  return dir
}

describe('the unmounted-jobs lint', () => {
  it('reports a src/jobs.ts nothing imports, pointing at src/plugins/jobs.ts', async () => {
    const found = unmountedJobs(await project({ 'src/jobs.ts': queues }), {})

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ code: 'unmounted-jobs', severity: 'warning', line: 1 })
    expect(found[0]!.help).toContain('src/plugins/jobs.ts')
  })

  it('accepts src/jobs.ts mounted by a plugin or by src/server.ts', async () => {
    expect(unmountedJobs(await project({ 'src/jobs.ts': queues, 'src/plugins/jobs.ts': 'export { welcomeMails as default } from \'../jobs\'\n' }), {})).toEqual([])
    expect(unmountedJobs(await project({ 'src/jobs.ts': queues, 'src/server.ts': 'import { welcomeMails } from \'./jobs\'\n' }), {})).toEqual([])
  })

  it('reads a plugin folder holding a subfolder and a helper without failing', async () => {
    const dir = await project({ 'src/jobs.ts': queues, 'src/plugins/nested/other.ts': 'export const a = 1\n', 'src/plugins/_helper.ts': 'import \'../jobs\'\n' })

    expect(unmountedJobs(dir, {})).toHaveLength(1)
  })

  it('resolves each specifier against its own file, not by its last segment', async () => {
    expect(unmountedJobs(await project({ 'src/jobs.ts': queues, 'src/plugins/a.ts': 'import \'./jobs\'\n', 'src/plugins/jobs.ts': 'import \'../lib/jobs\'\n' }), {})).toHaveLength(1)
    expect(unmountedJobs(await project({ 'src/jobs.ts': queues, 'src/plugins/a.ts': 'export { x as default } from \'../jobs.js\'\n' }), {})).toEqual([])
  })

  it('follows a tsconfig path alias', async () => {
    const tsconfig = JSON.stringify({ compilerOptions: { paths: { '~/*': ['./src/*'] } } })

    expect(unmountedJobs(await project({ 'tsconfig.json': tsconfig, 'src/jobs.ts': queues, 'src/plugins/a.ts': 'import \'~/jobs\'\n' }), {})).toEqual([])
    expect(unmountedJobs(await project({ 'src/jobs.ts': queues, 'src/plugins/a.ts': 'import \'~/jobs\'\n' }), {})).toHaveLength(1)
  })

  it('has nothing to say of src/plugins/jobs.ts alone, and honours allow', async () => {
    expect(unmountedJobs(await project({ 'src/plugins/jobs.ts': queues }), {})).toEqual([])
    expect(unmountedJobs(await project({ 'src/jobs.ts': queues }), { lints: { 'unmounted-jobs': 'allow' } })).toEqual([])
  })
})
