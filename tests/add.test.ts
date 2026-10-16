import type { Feature } from '../src/new'
import { expect, it } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { addExtension, addFeatures, detectFeatures } from '../src/add'
import { createProject, PRESETS } from '../src/new'

const repo = join(import.meta.dir, '..')
const SECRET = /^SESSION_SECRET=.*$/m

// The order of a manifest's keys and of an ignore file's lines does not matter, and a secret is random.
async function content(dir: string, path: string): Promise<unknown> {
  if (path === 'package.json')
    return await Bun.file(join(dir, path)).json() as unknown

  const text = (await Bun.file(join(dir, path)).text()).replace(SECRET, 'SESSION_SECRET=x')

  return path.endsWith('ignore') ? text.split('\n').toSorted() : text
}

async function snapshot(dir: string): Promise<Record<string, unknown>> {
  const paths = (await readdir(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(dir.length + 1))

  return Object.fromEntries(await Promise.all(paths.toSorted().map(async path => [path, await content(dir, path)] as const)))
}

// A project made with `from`, then given `added`, against the one `kay new` makes with both.
async function addedEqualsNew(from: readonly Feature[], added: readonly string[], all: readonly Feature[]): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'kay-add-'))

  try {
    await createProject(join(root, 'grown/app'), { kay: '^1.0.0', features: from })
    await createProject(join(root, 'whole/app'), { kay: '^1.0.0', features: all })
    await addFeatures(join(root, 'grown/app'), added, { install: false })

    expect({ from, added, files: await snapshot(join(root, 'grown/app')) }).toEqual({ from, added, files: await snapshot(join(root, 'whole/app')) })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('adds a feature to a project writing what kay new --with would have', async () => {
  const site = PRESETS.site.features

  await addedEqualsNew(['server'], ['starter', 'tailwind', 'accents'], ['server', 'starter', 'tailwind', 'accents'])
  await addedEqualsNew(PRESETS.server.features, ['auth'], [...PRESETS.server.features, 'auth'])
  await addedEqualsNew([...PRESETS.server.features, 'auth', 'postgres'], ['ws'], [...PRESETS.app.features, 'postgres'])
  await addedEqualsNew(site.filter(feature => feature !== 'eslint' && feature !== 'tests'), ['eslint', 'tests'], site)
  await addedEqualsNew(site, ['docker'], site)
})

it('reads the features a project holds off its files', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await createProject(dir, { kay: '^1.0.0', features: [...PRESETS.app.features, 'postgres'] })
    const expected: Feature[] = [...PRESETS.app.features, 'postgres']

    expect([...await detectFeatures(dir)].toSorted()).toEqual(expected.toSorted())
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('names what a feature needs, and writes nothing', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await createProject(dir, { kay: '^1.0.0', features: PRESETS.site.features })

    const before = await snapshot(dir)

    await expect(addFeatures(dir, ['auth'], { install: false })).rejects.toThrow('kay add: auth needs server: run `kay add server,auth` to add them together')
    await expect(addFeatures(dir, ['bogus'], { install: false })).rejects.toThrow('kay add: bogus is none of the features')
    expect(await snapshot(dir)).toEqual(before)
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('stops on a file it does not recognise with the edit to make by hand, writing nothing', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await createProject(dir, { kay: '^1.0.0', features: ['server', 'starter'] })
    await writeFile(join(dir, 'src/routes/_layout.kay'), 'main\n  slot\n')
    await writeFile(join(dir, 'src/components/counter.kay'), 'p mine\n')

    const before = await snapshot(dir)
    let message = ''

    try {
      await addFeatures(dir, ['tailwind'], { install: false })
    }
    catch (error) {
      message = (error as Error).message
    }

    expect(message).toStartWith('kay add: nothing was written')
    expect(message).toContain('src/routes/_layout.kay is not what `kay new` wrote, so apply this by hand:')
    expect(message).toContain('+main#main-content.mx-auto.w-full.max-w-5xl.grow.px-8.py-6')
    expect(await snapshot(dir)).toEqual(before)

    await writeFile(join(dir, 'package.json'), '{ not json')
    await expect(addFeatures(dir, ['tests'], { install: false })).rejects.toThrow('package.json is not valid JSON')
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('does not swap an app on SQLite for Postgres behind its back', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await createProject(dir, { kay: '^1.0.0', features: PRESETS.app.features })
    await expect(addFeatures(dir, ['postgres'], { install: false })).rejects.toThrow('.env: DATABASE_URL=sqlite://data/app.db is not what the feature uses: set DATABASE_URL=postgres://')
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('keeps the files the author wrote in, and the lines they added to a shared file', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
    await writeFile(join(dir, '.gitignore'), `${await Bun.file(join(dir, '.gitignore')).text()}notes.txt\n`)
    await writeFile(join(dir, 'AGENTS.md'), 'mine\n')
    await addFeatures(dir, ['auth'], { install: false })

    expect(await Bun.file(join(dir, '.gitignore')).text()).toContain('notes.txt\n')
    expect((await Bun.file(join(dir, '.gitignore')).text()).split('\n')).toContain('data')
    expect(await Bun.file(join(dir, 'AGENTS.md')).text()).toBe('mine\n')
    expect(await Bun.file(join(dir, 'package.json')).text()).toContain('"dev": "pg-orm apply && kay dev"')
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('adds the extension of a library to kay.config.ts and writes its files', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
    // What `bun add` would have installed: the workspace copy of the library.
    await mkdir(join(dir, 'node_modules/@kaynooo'), { recursive: true })
    await symlink(join(repo, 'packages/mail'), join(dir, 'node_modules/@kaynooo/kayjs-mail'))

    const manifest = await Bun.file(join(dir, 'package.json')).json() as { dependencies: Record<string, string> }

    manifest.dependencies['@kaynooo/kayjs-mail'] = '~1.0.0'
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))

    const result = await addFeatures(dir, ['mail'], { install: false })

    expect(result.written).toEqual(['kay.config.ts', 'src/mail.ts'])
    expect(result.notes).toEqual([expect.stringContaining('SMTP_HOST')])
    expect(await Bun.file(join(dir, 'kay.config.ts')).text()).toContain('extensions: [mailExtension(\'./src/mail\')],')
    expect(await Bun.file(join(dir, 'kay.config.ts')).text()).toContain('import { mailExtension } from \'@kaynooo/kayjs-mail\'\n')
    expect(await Bun.file(join(dir, 'src/mail.ts')).text()).toContain('export const mail = mailer()')

    // A second run finds both done.
    expect((await addFeatures(dir, ['mail'], { install: false })).written).toEqual([])
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('puts an extension first in an existing list, and refuses a config without defineConfig', () => {
  const extension = { import: 'import { cms } from \'@kaynooo/kayjs-cms\'', expression: 'cms()' }

  expect(addExtension('import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({\n  lang: \'en\',\n  extensions: [other()],\n})\n', extension)).toBe('import { defineConfig } from \'kay/server\'\nimport { cms } from \'@kaynooo/kayjs-cms\'\n\nexport default defineConfig({\n  lang: \'en\',\n  extensions: [cms(), other()],\n})\n')
  expect(addExtension('export default { lang: \'en\' }\n', extension)).toBeUndefined()
})

it('runs as kay add, printing what it wrote', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await createProject(dir, { kay: '^1.0.0', features: ['server'] })

    const child = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'add', 'starter,tailwind', dir, '--no-install'], { stdout: 'pipe', stderr: 'pipe' })
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

    expect(code).toBe(0)
    expect(out).toContain('added')
    expect(out).toContain('src/components/header.kay')
    expect((await detectFeatures(dir)).has('tailwind')).toBe(true)

    const bare = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'add'], { stdout: 'pipe', stderr: 'pipe' })

    expect(await bare.exited).toBe(1)
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})
