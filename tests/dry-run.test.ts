import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { createProject } from '../src/new'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '../src/cli.ts')
const dirs: string[] = []
const unformatted = '---  client\nconst a = 1\n---\np {a}\n'

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('dry-run-')

  dirs.push(root)
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function kay(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

describe('--dry-run', () => {
  it('fmt lists the files it would format and writes none', async () => {
    const root = await project({ 'src/a.kay': unformatted })
    const { stdout, code } = await kay(['fmt', 'src', '--dry-run'], root)

    expect(code).toBe(0)
    expect(stdout).toContain('would format src/a.kay')
    expect(await Bun.file(join(root, 'src/a.kay')).text()).toBe(unformatted)
  })

  it('fmt --check still fails on an unformatted file', async () => {
    const root = await project({ 'src/a.kay': unformatted })

    expect((await kay(['fmt', 'src', '--check'], root)).code).toBe(1)
  })

  it('new lists the files and creates no directory', async () => {
    const root = await project({})
    const text = await kay(['new', 'app', '--template', 'blank', '--dry-run'], root)
    const json = await kay(['new', 'app', '--template', 'blank', '--dry-run', '--format', 'json'], root)

    expect(text.code).toBe(0)
    expect(text.stdout).toContain('would create app')
    expect(text.stdout).toContain('package.json')

    const document = JSON.parse(json.stdout) as { dryRun: boolean, files: string[] }

    expect(document.dryRun).toBe(true)
    expect(document.files).toContain('package.json')
    expect(await readdir(root)).toEqual([])
  })

  it('add plans its files and writes none', async () => {
    const root = await project({})

    await createProject(root, { kay: '^1.0.0', features: ['server'] })

    const before = await Bun.file(join(root, 'package.json')).text()
    const { stdout, code, stderr } = await kay(['add', 'tailwind', '--dry-run', '--format', 'json'], root)

    expect(code, stderr).toBe(0)

    const document = JSON.parse(stdout) as { dryRun: boolean, written: string[], installed: boolean }

    expect(document).toMatchObject({ dryRun: true, installed: false })
    expect(document.written.length).toBeGreaterThan(0)
    expect(await Bun.file(join(root, 'package.json')).text()).toBe(before)
  })

  it('migrate content and astro write nothing', async () => {
    const root = await project({ 'src/pages/index.astro': '---\n---\n<h1>Hi</h1>\n' })
    const { stdout, code, stderr } = await kay(['migrate', 'astro', '--dry-run', '--format', 'json'], root)

    expect(code, stderr).toBe(0)
    expect((JSON.parse(stdout) as { written: string[] }).written).toContain('src/routes/index.kay')
    expect(await Bun.file(join(root, 'src/routes/index.kay')).exists()).toBe(false)
  })

  it('migrate warns on --out, which stays until 1.73', async () => {
    const root = await project({ 'src/pages/index.astro': '---\n---\n<h1>Hi</h1>\n' })
    const { stderr, code } = await kay(['migrate', 'astro', '--out', 'out', '--dry-run'], root)

    expect(code).toBe(0)
    expect(stderr).toContain('--out is now --outdir; --out still works until 1.73')
  })
})
