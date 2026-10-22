import type { Feature } from '../src/new'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { expect, it } from 'bun:test'
import { addExtension, addFeatures, detectFeatures, handEdit, restore, runnerOf, snapshot as snapshotManifest } from '../src/add'
import { createProject, PRESETS } from '../src/new'

const repo = join(import.meta.dir, '..')

// The order of a manifest's keys and of an ignore file's lines does not matter.
async function content(dir: string, path: string): Promise<unknown> {
  if (path === 'package.json')
    return await Bun.file(join(dir, path)).json() as unknown

  const text = await Bun.file(join(dir, path)).text()

  return path.endsWith('ignore') ? text.split('\n').toSorted() : text
}

async function snapshot(dir: string): Promise<Record<string, unknown>> {
  const paths = (await readdir(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile() && !entry.parentPath.includes('node_modules')).map(entry => join(entry.parentPath, entry.name).slice(dir.length + 1))

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
  await addedEqualsNew(PRESETS.server.features, ['ws'], [...PRESETS.server.features, 'ws'])
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

    await expect(addFeatures(dir, ['ws'], { install: false })).rejects.toThrow('kay add: ws needs server: run `kay add server,ws` to add them together')
    await expect(addFeatures(dir, ['postgres'], { install: false })).rejects.toThrow('postgres needs server: run `kay add server,postgres`')
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
    await mkdir(join(dir, 'data'))
    await Bun.write(join(dir, 'data/auth.db'), '')
    await expect(addFeatures(dir, ['postgres'], { install: false })).rejects.toThrow('data/auth.db holds the users postgres would leave behind')
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('keeps the files the author wrote in, and the lines they added to a shared file', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features.filter(feature => feature !== 'eslint') })
    await writeFile(join(dir, '.gitignore'), `${await Bun.file(join(dir, '.gitignore')).text()}notes.txt\n`)
    await writeFile(join(dir, 'AGENTS.md'), 'mine\n')
    await addFeatures(dir, ['eslint'], { install: false })

    expect(await Bun.file(join(dir, '.gitignore')).text()).toContain('notes.txt\n')
    expect((await Bun.file(join(dir, '.gitignore')).text()).split('\n')).toContain('.eslintcache')
    expect(await Bun.file(join(dir, 'AGENTS.md')).text()).toBe('mine\n')
    expect(await Bun.file(join(dir, 'package.json')).text()).toContain('"lint":')
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
    expect(result.notes).toEqual([expect.stringContaining('MAIL_URL')])
    expect(await Bun.file(join(dir, 'kay.config.ts')).text()).toContain('extensions: [mail({ module: \'./src/mail\' })],')
    expect(await Bun.file(join(dir, 'kay.config.ts')).text()).toContain('import { mail } from \'@kaynooo/kayjs-mail\'\n')
    expect(await Bun.file(join(dir, 'src/mail.ts')).text()).toContain('export const mail = mailer()')

    // A second run finds both done.
    expect((await addFeatures(dir, ['mail'], { install: false })).written).toEqual([])
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('plans the package.json write of a library that resolves but is not in package.json, on a dry run', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
    await mkdir(join(dir, 'node_modules/@kaynooo'), { recursive: true })
    await symlink(join(repo, 'packages/mail'), join(dir, 'node_modules/@kaynooo/kayjs-mail'))

    const before = await Bun.file(join(dir, 'package.json')).text()
    const result = await addFeatures(dir, ['mail'], { dryRun: true })

    expect(result.written).toContain('package.json')
    expect(await Bun.file(join(dir, 'package.json')).text()).toBe(before)
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('adds kayjs-ai as its extension alone, with no file', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
    await mkdir(join(dir, 'node_modules/@kaynooo'), { recursive: true })
    await symlink(join(repo, 'packages/ai'), join(dir, 'node_modules/@kaynooo/kayjs-ai'))

    const manifest = await Bun.file(join(dir, 'package.json')).json() as { dependencies: Record<string, string> }

    manifest.dependencies['@kaynooo/kayjs-ai'] = '~1.0.0'
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))

    const result = await addFeatures(dir, ['ai'], { install: false })

    expect(result.written).toEqual(['kay.config.ts'])
    expect(result.notes).toEqual([expect.stringContaining('AI_MODEL')])
    expect(await Bun.file(join(dir, 'kay.config.ts')).text()).toContain('extensions: [ai()],')
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('puts an extension first in an existing list, and refuses a config without defineConfig', () => {
  const extension = { import: 'import { cms } from \'@kaynooo/kayjs-cms\'', expression: 'cms()' }

  expect(addExtension('import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({\n  lang: \'en\',\n  extensions: [other()],\n})\n', extension)).toBe('import { cms } from \'@kaynooo/kayjs-cms\'\nimport { defineConfig } from \'kay/server\'\n\nexport default defineConfig({\n  lang: \'en\',\n  extensions: [cms(), other()],\n})\n')
  expect(addExtension('export default { lang: \'en\' }\n', extension)).toBeUndefined()
  const mail = { import: 'import { mail } from \'@kaynooo/kayjs-mail\'', expression: 'mail({ module: \'./src/mail\' })' }
  const former = 'import { mailExtension } from \'@kaynooo/kayjs-mail\'\nexport default defineConfig({ extensions: [mailExtension(\'./src/mail\')] })\n'

  expect(addExtension(former, mail)).toBe(former)
  expect(addExtension('import { defineConfig } from \'kay/server\'\nexport default defineConfig({ extensions: [] })\n', mail)).toContain('import { mail } from \'@kaynooo/kayjs-mail\'')
})

it('leaves the project as it was when a library refuses, package.json included', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
    await mkdir(join(dir, 'node_modules/@kaynooo'), { recursive: true })
    await symlink(join(repo, 'packages/mail'), join(dir, 'node_modules/@kaynooo/kayjs-mail'))
    await writeFile(join(dir, 'src/mail.ts'), 'export const mail = 1\n')

    const manifest = await Bun.file(join(dir, 'package.json')).json() as { dependencies: Record<string, string> }

    manifest.dependencies['@kaynooo/kayjs-mail'] = '~1.0.0'
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))

    const files = ['package.json', 'kay.config.ts', 'src/mail.ts', '.gitignore']
    const before = await Promise.all(files.map(async file => content(dir, file)))

    await expect(addFeatures(dir, ['ws', 'mail'], { install: false })).rejects.toThrow('src/mail.ts exists and is not the file mail writes')
    expect(await Promise.all(files.map(async file => content(dir, file)))).toEqual(before)
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('puts package.json and the lockfile back as they were, one a bun add made included', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), '{ "name": "a" }\n')
    await writeFile(join(dir, 'bun.lock'), 'old lock')

    const kept = await snapshotManifest(dir)

    await writeFile(join(dir, 'package.json'), '{ "name": "changed" }')
    await writeFile(join(dir, 'bun.lock'), 'new lock')
    await writeFile(join(dir, 'bun.lockb'), 'made by bun add')
    await restore(dir, kept)

    expect(await Bun.file(join(dir, 'package.json')).text()).toBe('{ "name": "a" }\n')
    expect(await Bun.file(join(dir, 'bun.lock')).text()).toBe('old lock')
    expect(await Bun.file(join(dir, 'bun.lockb')).exists()).toBe(false)
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('adds an extension without breaking a config it does not recognise', async () => {
  const extension = { import: 'import { cms } from \'@kaynooo/kayjs-cms\'', expression: 'cms()' }
  const multiline = 'import {\n  defineConfig,\n} from \'kay/server\'\n\nexport default defineConfig({})\n'

  expect(addExtension(multiline, extension)).toBe('import { cms } from \'@kaynooo/kayjs-cms\'\nimport {\n  defineConfig,\n} from \'kay/server\'\n\nexport default defineConfig({\n  extensions: [cms()],\n})\n')
  // Configured by hand already: left as it is, and a list held in a variable is a shape it stops at.
  expect(addExtension('import { cms, forgejo } from \'@kaynooo/kayjs-cms\'\nexport default defineConfig({ extensions: [cms({ files: forgejo() })] })\n', extension)).toContain('extensions: [cms({ files: forgejo() })] })')
  expect(addExtension('import { cms, forgejo } from \'@kaynooo/kayjs-cms\'\nexport default defineConfig({ extensions: [cms({ files: forgejo() })] })\n', extension)!.match(/cms\(/g)).toHaveLength(1)
  expect(addExtension('export default defineConfig({ extensions: list })\n', extension)).toBeUndefined()
  expect(addExtension('export default defineConfig({ extensions: [] })\n', extension)).toBe('import { cms } from \'@kaynooo/kayjs-cms\'\n\nexport default defineConfig({ extensions: [cms()] })\n')
})

it('refuses a name that is no feature, an inherited one included', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
    await expect(addFeatures(dir, ['constructor'], { install: false })).rejects.toThrow('kay add: constructor is none of the features')
    await expect(addFeatures(dir, ['mail'], { install: false })).rejects.toThrow('is not installed, and --no-install')
    // Everything is there already: nothing to write.
    expect((await addFeatures(dir, ['server', 'tests'], { install: false })).written).toEqual([])
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
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

// A `bun` that records its arguments and then runs the shell body, standing in for the real one.
async function stubBun(root: string, body: string): Promise<{ bun: string, calls: () => Promise<string[]> }> {
  const bun = join(root, 'stub-bun.sh')
  const log = join(root, 'calls.log')

  await writeFile(bun, `#!/bin/sh\necho "$@" >> '${log}'\n${body}\n`)
  await chmod(bun, 0o755)

  return { bun, calls: async () => (await Bun.file(log).exists() ? (await Bun.file(log).text()).trim().split('\n') : []) }
}

async function projectWith(root: string, features: readonly Feature[]): Promise<string> {
  const dir = join(root, 'app')

  await createProject(dir, { kay: '^1.0.0', features })

  return dir
}

it('restores package.json and the lockfile when a library refuses after a stubbed bun add', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kay-add-'))

  try {
    const dir = await projectWith(root, PRESETS.server.features)

    await writeFile(join(dir, 'bun.lock'), 'old lock')
    await mkdir(join(dir, 'node_modules/@kaynooo'), { recursive: true })
    await symlink(join(repo, 'packages/mail'), join(dir, 'node_modules/@kaynooo/kayjs-mail'))
    await writeFile(join(dir, 'src/mail.ts'), 'export const mail = 1\n')

    const before = await Bun.file(join(dir, 'package.json')).text()
    const manifest = JSON.parse(before) as { dependencies: Record<string, string> }

    manifest.dependencies['@kaynooo/kayjs-mail'] = '~1.0.0'
    await writeFile(join(root, 'after.json'), JSON.stringify(manifest))

    const { bun, calls } = await stubBun(root, `cp '${join(root, 'after.json')}' package.json\nprintf 'new lock' > bun.lock\nprintf 'binary' > bun.lockb`)

    await expect(addFeatures(dir, ['mail'], { bun })).rejects.toThrow('src/mail.ts exists and is not the file mail writes')
    expect(await calls()).toHaveLength(1)
    expect(await Bun.file(join(dir, 'package.json')).text()).toBe(before)
    expect(await Bun.file(join(dir, 'bun.lock')).text()).toBe('old lock')
    expect(await Bun.file(join(dir, 'bun.lockb')).exists()).toBe(false)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('installs @iconify-json/tabler as a dev dependency, as kay new does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kay-add-'))

  try {
    const dir = await projectWith(root, PRESETS.server.features.filter(feature => feature !== 'starter' && feature !== 'accents'))
    const { bun, calls } = await stubBun(root, 'exit 0')

    // The stub installs nothing, so the library cannot be loaded: the calls are what is checked.
    await expect(addFeatures(dir, ['cms'], { bun })).rejects.toThrow('is not installed')

    const lines = await calls()

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('add @kaynooo/kayjs-cms@~')
    expect(lines[0]).not.toContain('iconify')
    expect(lines[1]).toContain('add -d @iconify-json/tabler@')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps the error that made it restore when the restore fails too', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kay-add-'))

  try {
    const dir = await projectWith(root, PRESETS.server.features)
    const { bun } = await stubBun(root, 'rm -f package.json\nmkdir package.json\nprintf boom >&2\nexit 1')
    let message = ''

    try {
      await addFeatures(dir, ['mail'], { bun })
    }
    catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('kay add: bun add failed, nothing was written')
    expect(message).toContain('boom')
    expect(message).toContain('could not be put back')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('restores the lockfile of a monorepo root too', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kay-add-'))

  try {
    const dir = join(root, 'apps/web')

    await mkdir(dir, { recursive: true })
    await writeFile(join(root, 'package.json'), '{ "workspaces": ["apps/*"] }\n')
    await writeFile(join(root, 'bun.lock'), 'root lock')
    await writeFile(join(dir, 'package.json'), '{ "name": "web" }\n')

    const kept = await snapshotManifest(dir)

    await writeFile(join(root, 'bun.lock'), 'changed')
    await writeFile(join(dir, 'package.json'), '{}')
    await restore(dir, kept)

    expect(await Bun.file(join(root, 'bun.lock')).text()).toBe('root lock')
    expect(await Bun.file(join(dir, 'package.json')).text()).toBe('{ "name": "web" }\n')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('reads a trailing comment of a .env value as no part of it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kay-add-'))

  try {
    const dir = await projectWith(root, [...PRESETS.app.features, 'postgres'])
    const env = (await Bun.file(join(dir, '.env')).text()).split('\n').filter(line => line !== '').map((line, index) => {
      const [key, ...value] = line.split('=')

      return index % 2 === 0 ? `${line} # mine` : `${key}="${value.join('=')}" # mine`
    }).join('\n')

    await writeFile(join(dir, '.env'), `${env}\n`)
    expect((await addFeatures(dir, ['ws'], { install: false })).written).toEqual([])
    expect(await Bun.file(join(dir, '.env')).text()).toBe(`${env}\n`)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('reads export prefixed and quoted values of .env', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kay-add-'))
  const other = await mkdtemp(join(tmpdir(), 'kay-add-'))

  try {
    const dir = await projectWith(root, [...PRESETS.app.features, 'postgres'])
    const env = (await Bun.file(join(dir, '.env')).text()).split('\n').filter(line => line !== '').map((line) => {
      const [key, ...value] = line.split('=')

      return `export ${key}="${value.join('=')}"`
    }).join('\n')

    await writeFile(join(dir, '.env'), `${env}\n`)
    expect((await addFeatures(dir, ['ws'], { install: false })).written).toEqual([])
    expect(await Bun.file(join(dir, '.env')).text()).toBe(`${env}\n`)

    const sqlite = await projectWith(other, PRESETS.app.features)

    await writeFile(join(sqlite, '.env'), 'export DATABASE_URL="sqlite://data/app.db"\n')
    await expect(addFeatures(sqlite, ['postgres'], { install: false })).rejects.toThrow('.env: export DATABASE_URL="sqlite://data/app.db" is not what the feature uses')
  }
  finally {
    await rm(root, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

it('writes the workflow of the host the project remote or folder names, not the first one found', async () => {
  const features = PRESETS.site.features.filter(feature => feature !== 'ci')

  for (const [remote, folder, expected] of [['git@git.kaynooo.fr:a/b.git', '.github', '.forgejo'], ['git@github.com:a/b.git', '.forgejo', '.github'], ['', '.forgejo', '.forgejo'], ['', '.github', '.github']] as const) {
    const root = await mkdtemp(join(tmpdir(), 'kay-add-'))

    try {
      const dir = await projectWith(root, features)

      Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })

      if (remote !== '')
        Bun.spawnSync(['git', 'remote', 'add', 'origin', remote], { cwd: dir })

      await mkdir(join(dir, folder, 'workflows'), { recursive: true })

      const { written } = await addFeatures(dir, ['ci'], { install: false })

      expect({ remote, folder, workflow: written.find(path => path.endsWith('pages.yml')) }).toEqual({ remote, folder, workflow: `${expected}/workflows/pages.yml` })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it.each([
  ['runs-on: docker', 'docker'],
  ['runs-on: "docker"', 'docker'],
  ['runs-on: \'docker\'', 'docker'],
  ['runs-on: docker # self-hosted', 'docker'],
  ['runs-on: "docker" # self-hosted', 'docker'],
  ['runs-on: [docker]', 'docker'],
  ['runs-on: [self-hosted, docker]', undefined],
  ['runs-on: ${{ matrix.os }}', undefined],
])('reads the runner of a workflow written as %s', async (line, label) => {
  const root = await mkdtemp(join(tmpdir(), 'kay-add-'))

  try {
    await mkdir(join(root, '.forgejo/workflows'), { recursive: true })
    await Bun.write(join(root, '.forgejo/workflows/test.yml'), `jobs:\n  test:\n    ${line}\n    steps: []\n`)

    expect(await runnerOf(root, 'forgejo')).toBe(label)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rewrites the CI workflow on the runner the project was scaffolded with', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kay-add-'))

  try {
    const dir = join(root, 'app')
    const features: Feature[] = [...PRESETS.server.features, 'auth']

    await createProject(dir, { kay: '^1.0.0', features, runner: 'docker' })

    const { written } = await addFeatures(dir, ['postgres'], { install: false })

    expect(written).toContain('.forgejo/workflows/test.yml')

    const workflow = await Bun.file(join(dir, '.forgejo/workflows/test.yml')).text()

    expect(workflow).toContain('runs-on: docker\n')
    expect(workflow).not.toContain('runs-on: debian')
    expect(workflow).toContain('postgres')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('names a file the author deleted rather than skipping it silently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kay-add-'))

  try {
    const dir = await projectWith(root, ['server', 'starter'])

    await rm(join(dir, 'src/routes/_layout.kay'))

    const result = await addFeatures(dir, ['tailwind'], { install: false })

    expect(result.written).not.toContain('src/routes/_layout.kay')
    expect(result.notes).toEqual([expect.stringContaining('src/routes/_layout.kay was deleted')])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('shows a hand edit as an ordered diff', () => {
  expect(handEdit('a\nb\nc\nd\n', 'a\nB\nc\nD\n')).toBe('-b\n+B\n-d\n+D')
  // A moved line is a change, which a set of lines would not see.
  expect(handEdit('a\nb\n', 'b\na\n')).not.toBe('')
  expect(handEdit('x\nsame\ny\n', 'x\nz\nsame\ny\n')).toBe('+z')
  expect(handEdit('p\nq\n', 'p\nq\n')).toBe('')
})

// A project with the workspace copies of kay's libraries linked into its node_modules, as `bun add` would have left them.
async function linkedProject(dir: string, features: readonly Feature[], libraries: readonly string[]): Promise<void> {
  await createProject(dir, { kay: '^1.0.0', features })
  await mkdir(join(dir, 'node_modules/@kaynooo'), { recursive: true })

  for (const library of libraries)
    await symlink(join(repo, `packages/${library}`), join(dir, `node_modules/@kaynooo/kayjs-${library}`))
}

it('adds the ui extension with no line in the layout or the stylesheet', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await linkedProject(dir, PRESETS.server.features, ['ui'])

    const result = await addFeatures(dir, ['ui'], { install: false })

    expect(result.written).toEqual(['kay.config.ts'])

    const config = await Bun.file(join(dir, 'kay.config.ts')).text()

    expect(config).toContain('import { ui } from \'@kaynooo/kayjs-ui/extension\'')
    expect(config).toContain('extensions: [ui()]')
    expect((await addFeatures(dir, ['ui'], { install: false })).written).toEqual([])
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('refuses ui in a project without Tailwind, naming the command that adds both', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await linkedProject(dir, ['server'], ['ui'])
    await expect(addFeatures(dir, ['ui'], { install: false })).rejects.toThrow('ui needs tailwind: run `kay add tailwind,ui`')
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('adds kayjs-auth over a SQLite file of its own, with the guard and the ui extension', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'my-shop')

  try {
    await linkedProject(dir, PRESETS.server.features, ['auth', 'ui'])

    const result = await addFeatures(dir, ['auth'], { install: false })

    expect(result.written).toEqual(['.env.example', '.gitignore', 'kay.config.ts', 'src/auth.ts', 'src/routes/_guard.ts'])

    const source = await Bun.file(join(dir, 'src/auth.ts')).text()

    expect(source).toContain('export const db = new Database({ url: \'sqlite://data/auth.db\', tables: [...authTables] })')
    expect(source).toContain('site: \'My Shop\'')
    expect(source).not.toContain('mail.')
    expect(await Bun.file(join(dir, 'src/routes/_guard.ts')).text()).toContain('export default auth.guard()')

    const config = await Bun.file(join(dir, 'kay.config.ts')).text()

    expect(config).toContain('authPages({ auth: async () => import(\'./src/auth\') })')
    expect(config).toContain('ui()')
    expect(await Bun.file(join(dir, '.env.example')).text()).toMatch(/^SITE_URL=$/m)
    expect(await Bun.file(join(dir, '.gitignore')).text()).toMatch(/^data$/m)
    expect(result.notes.join('\n')).toContain('kay add mail')

    // A second run changes nothing.
    expect((await addFeatures(dir, ['auth'], { install: false })).written).toEqual([])
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('adds kayjs-auth over the project\'s pg-orm tables and its mailer', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await linkedProject(dir, PRESETS.server.features, ['auth', 'ui', 'mail'])
    await mkdir(join(dir, 'src/db'), { recursive: true })
    await writeFile(join(dir, 'src/db/index.ts'), 'import { Database } from \'@kaynooo/pg-orm\'\nimport { Member } from \'./member\'\n\nexport const tables = [Member]\n\nexport const db = new Database({ url: process.env.DATABASE_URL!, tables })\n')

    const manifest = await Bun.file(join(dir, 'package.json')).json() as { dependencies: Record<string, string> }

    manifest.dependencies['@kaynooo/pg-orm'] = '^7.0.0'
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))

    const result = await addFeatures(dir, ['mail', 'auth'], { install: false })

    expect(result.written).toContain('src/db/index.ts')

    const tables = await Bun.file(join(dir, 'src/db/index.ts')).text()

    expect(tables).toContain('export const tables = [...authTables, Member]')
    expect(tables).toContain('import { authTables } from \'@kaynooo/kayjs-auth/pg\'')

    const source = await Bun.file(join(dir, 'src/auth.ts')).text()

    expect(source).toContain('import { db } from \'./db\'')
    expect(source).toContain('email: { mailer: { send: mail.enqueue } },')
    expect(source).not.toContain('sqlite://')
    expect((await addFeatures(dir, ['mail', 'auth'], { install: false })).written).toEqual([])
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('adds postgres to a project without the demo sign-in, which it plans under it', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await createProject(dir, { kay: '^1.0.0', features: PRESETS.server.features })
    await addFeatures(dir, ['postgres'], { install: false })

    expect([...await detectFeatures(dir)]).toEqual(expect.arrayContaining(['auth', 'postgres']))
    expect((await addFeatures(dir, ['postgres'], { install: false })).written).toEqual([])
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('adds kayjs-auth over the Postgres database postgres sets up, with no demo sign-in', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await linkedProject(dir, PRESETS.server.features, ['auth', 'ui'])
    await addFeatures(dir, ['auth', 'postgres'], { install: false })

    expect(existsSync(join(dir, 'compose.dev.yaml'))).toBe(true)
    expect(existsSync(join(dir, 'src/routes/login.kay'))).toBe(false)
    expect(existsSync(join(dir, 'src/session.ts'))).toBe(false)

    const tables = await Bun.file(join(dir, 'src/db/index.ts')).text()

    expect(tables).toContain('authTables')
    expect(await Bun.file(join(dir, 'src/auth.ts')).text()).toContain('import { db } from \'./db\'')
    expect((await addFeatures(dir, ['auth', 'postgres'], { install: false })).written).toEqual([])
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})

it('writes the server beside kayjs-auth and postgres, and leaves a kayjs-auth project\'s sign-in alone', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'kay-add-')), 'app')

  try {
    await linkedProject(dir, PRESETS.site.features, ['auth', 'ui'])
    await addFeatures(dir, ['server', 'auth', 'postgres'], { install: false })

    expect(await Bun.file(join(dir, 'src/server.ts')).text()).not.toContain('session')
    expect(existsSync(join(dir, 'src/routes/login.kay'))).toBe(false)
    expect((await addFeatures(dir, ['postgres'], { install: false })).written).toEqual([])
  }
  finally {
    await rm(join(dir, '..'), { recursive: true, force: true })
  }
})
