import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { runProjectChecks } from '../src/commands/project-checks'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '../src/cli.ts')
const dirs: string[] = []

interface Problem { file: string, line: number, column: number, severity: string, code: string | null, message: string }

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function project(config: string, files: Record<string, string> = {}): Promise<string> {
  const root = await scratchDir('checks-')

  dirs.push(root)
  await Promise.all(Object.entries({ 'tsconfig.json': '{ "extends": "kay/tsconfig.json" }\n', 'kay.config.ts': `import { defineConfig } from 'kay/server'\n\nexport default defineConfig(${config})\n`, 'src/routes/index.kay': 'h1 Hi\n', ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function check(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, 'check', root, '--format', 'json', ...args], { cwd: root, env: { PATH: process.env.PATH! }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const { errors, warnings, problems } = JSON.parse(stdout) as { errors: number, warnings: number, problems: Problem[] }

  return { code, errors, warnings, problems: problems.filter(({ code }) => code === null || !code.startsWith('TS')) }
}

describe('checks in kay.config.ts', () => {
  it('exits 1 on a failing project check and names it with its file and line in --format json', async () => {
    const root = await project('{\n  favicon: false,\n  checks: [async ({ root, report }) => {\n    if (!(await Bun.file(`${root}/compose.prod.yaml`).exists()))\n      report({ level: \'error\', message: \'compose.prod.yaml is missing\', file: \'compose.prod.yaml\', line: 3 })\n  }],\n}\n')
    const { code, errors, problems } = await check(root)

    expect(code).toBe(1)
    expect(errors).toBe(1)
    expect(problems).toEqual([{ file: 'compose.prod.yaml', line: 3, column: 1, severity: 'error', code: null, message: 'compose.prod.yaml is missing' }])
  })

  it('reports a throwing check, sync or async, and still runs the others', async () => {
    const root = await project('{\n  favicon: false,\n  checks: [\n    () => { throw new Error(\'sync boom\') },\n    async () => { throw new Error(\'async boom\') },\n    ({ report }) => report({ message: \'the third ran\' }),\n  ],\n}\n')
    const { code, problems } = await check(root)

    expect(code).toBe(1)
    expect(problems.map(({ message }) => message)).toEqual([
      'the check checks[0] of kay.config.ts threw: sync boom',
      'the check checks[1] of kay.config.ts threw: async boom',
      'the third ran',
    ])
    expect(problems[0]!.file).toBe('kay.config.ts')
  })

  it('fails on a warning only under --deny-warnings, defaulting a finding to an error and its position to 1:1', async () => {
    const root = await project('{ favicon: false, checks: [({ report }) => { report({ level: \'warning\', message: \'careful\', code: \'mine\' }) }] }\n')

    expect((await check(root)).code).toBe(0)
    expect((await check(root, '--deny-warnings')).code).toBe(1)
    expect((await check(root)).problems).toEqual([{ file: 'kay.config.ts', line: 1, column: 1, severity: 'warning', code: 'mine', message: 'careful' }])
  })

  it('gives the project\'s routes once, when a check asks, and leaves project findings out of --only and --since', async () => {
    const root = await project('{ favicon: false, checks: [async ({ routes, report }) => { const [a, b] = [await routes(), await routes()]; report({ message: `routes ${a.map(route => route.path).includes(\'/\')} ${a === b}` }) }] }\n')

    expect((await check(root)).problems.map(({ message }) => message)).toEqual(['routes true false'])
    expect((await check(root, '--only', 'seo')).problems).toEqual([])
    expect((await check(root, '--since', '1.40')).problems).toEqual([])
  })

  it('reports only the findings in the paths given', async () => {
    const root = await project('{ favicon: false, checks: [({ report }) => { report({ message: \'a\', file: \'src/a.txt\' }); report({ message: \'b\', file: \'docs/b.txt\' }) }] }\n', { 'src/a.txt': '', 'docs/b.txt': '' })
    const child = Bun.spawn([process.execPath, cli, 'check', root, 'docs', '--format', 'json'], { cwd: root, env: { PATH: process.env.PATH! }, stdout: 'pipe', stderr: 'pipe' })
    const { problems } = JSON.parse(await new Response(child.stdout).text()) as { problems: Problem[] }

    expect(problems.filter(({ file }) => file.endsWith('.txt')).map(({ message }) => message)).toEqual(['b'])
  })

  it('names an entry that is not a function', async () => {
    const root = await project('{ favicon: false, checks: [\'nope\'] }\n')

    expect((await check(root)).problems.map(({ message }) => message)).toEqual(['the check checks[0] of kay.config.ts threw: it is not a function'])
  })

  it('cuts off a check that does not finish, drops its late findings and keeps the others', async () => {
    const root = await scratchDir('checks-')

    dirs.push(root)

    const late: (() => void)[] = []
    const problems = await runProjectChecks(root, {
      checks: [
        async ({ report }) => new Promise<void>((resolve) => {
          late.push(() => {
            report({ message: 'too late' })
            resolve()
          })
        }),
        ({ report }) => report({ message: 'on time', level: 'warning' }),
      ],
    }, 20)

    late[0]!()

    expect(problems.map(({ message, severity }) => `${severity} ${message}`)).toEqual(['error the check checks[0] of kay.config.ts did not finish within 0.02 seconds', 'warning on time'])
  })
})
