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

  it('migrate content lists the files it would rewrite and rewrites none', async () => {
    const entry = '{"name":"Old"}'
    const root = await project({
      'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({})\n',
      'src/content.config.ts': 'import { t } from \'elysia\'\nimport { collection, renameField } from \'kay/content\'\n\nexport const packs = collection(\'content/packs\', { schema: t.Object({ title: t.String() }), migrations: [renameField(\'name\', \'title\')] })\n',
      'src/content/packs/old.json': entry,
    })
    const { stdout, code, stderr } = await kay(['migrate', 'content', '--dry-run'], root)

    expect(code, stderr).toBe(0)
    expect(stdout).toContain('would rewrite src/content/packs/old.json')
    expect(stdout).toContain('1 file to rewrite')
    expect(await Bun.file(join(root, 'src/content/packs/old.json')).text()).toBe(entry)
  })

  it('fmt refuses --check beside --dry-run', async () => {
    const { stderr, code } = await kay(['fmt', '--check', '--dry-run'], await project({}))

    expect(code).toBe(1)
    expect(stderr).toContain('--check fails on an unformatted file')
  })

  it('not-found --redirect lists the redirect it would add and writes none', async () => {
    const config = 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ redirects: {} })\n'
    const root = await project({ 'kay.config.ts': config })
    const { stdout, code, stderr } = await kay(['not-found', '--redirect', '/old', '--to', '/new', '--dry-run', '--format', 'json'], root)

    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ redirect: { from: '/old', to: '/new', dryRun: true } })
    expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe(config)
  })
})

describe('--format json', () => {
  it('types prints the count of files it wrote', async () => {
    const root = await project({})

    await createProject(root, { kay: '^1.0.0', features: ['server'] })

    const { stdout, code, stderr } = await kay(['types', '--format', 'json'], root)

    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ dir: '.kay/types' })
  })

  it('new and add print the failure document when they cannot run', async () => {
    const root = await project({})
    const created = await kay(['new', 'app', '--template', 'bogus', '--format', 'json'], root)

    await createProject(join(root, 'site'), { kay: '^1.0.0', features: ['server'] })

    const added = await kay(['add', 'bogus', 'site', '--format', 'json'], root)

    for (const { stdout, code } of [created, added]) {
      expect(code).toBe(1)
      expect(JSON.parse(stdout)).toMatchObject({ errors: 1, warnings: 0 })
    }
  })

  it('new warns that --host stays until 1.73', async () => {
    const { stderr } = await kay(['new', 'app', '--template', 'blank', '--host', 'github', '--dry-run'], await project({}))

    expect(stderr).toContain('until 1.73')
  })
})
