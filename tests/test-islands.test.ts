import { existsSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { clientDir, inOutput, outputDir, testWorker } from '../src/build/assets'
import * as client from '../src/build/client'
import * as files from '../src/build/files'
import { testSite } from '../src/test'
import { scratchDir } from './scratch'

const ISLAND = '---\nimport { hello } from \'./greeting\'\nimport logo from \'../logo.png\'\nconst count = signal(0)\nconst work = () => new Worker(new URL(\'../echo.ts\', import.meta.url), { type: \'module\' })\n---\nbutton(onClick={() => count.set(count() + 1)}) {hello()} {count()}\nimg(src={logo} onClick={work})\n'
const BROWSERLESS = 'import { Database } from \'bun:sqlite\'\nexport const hello = () => String(Database.name)\n'
const FINE = 'export const hello = () => \'hi\'\n'

// One process serves one project, so every test of this file edits this one.
let root = ''
let greeting = ''

// The folder of the newest check build, as each options key has one of its own.
function checkDir(): string {
  const dirs = readdirSync(join(root, '.kay')).filter(name => name.startsWith(`test-client${testWorker()}.`) && existsSync(join(root, '.kay', name, 'manifest.json')))
  const time = (name: string): number => Bun.file(join(root, '.kay', name, 'manifest.json')).lastModified

  return join(root, '.kay', dirs.sort((a, b) => time(b) - time(a))[0] ?? 'missing')
}

const manifest = (): string => join(checkDir(), 'manifest.json')

beforeAll(async () => {
  root = await scratchDir('test-islands-')
  greeting = join(root, 'src/greeting.ts')
  await Bun.write(join(root, 'src/logo.png'), Bun.file(join(import.meta.dir, 'fixtures/site/src/logo.png')))
  await Bun.write(join(root, 'src/echo.ts'), 'onmessage = event => postMessage(event.data)\n')
  await Bun.write(join(root, 'src/routes/index.kay'), ISLAND.replace('./greeting', '../greeting'))
})

describe('testSite builds the islands', () => {
  it('fails when an island reaches a module a browser cannot build', async () => {
    await Bun.write(greeting, BROWSERLESS)

    await expect(testSite({ root })).rejects.toThrow('browser has no bun:sqlite')
  })

  it('passes an island that builds, rendering its markup without scripts', async () => {
    await Bun.write(greeting, FINE)

    const page = await (await testSite({ root })).visit('/')

    expect(page.html).toContain('hi')
    expect(page.html).not.toContain('<script src')
    expect(page.html).not.toContain('modulepreload')
  })

  it('builds again once a source changed, and not at all with islands: false', async () => {
    await Bun.write(greeting, BROWSERLESS)

    await expect(testSite({ root })).rejects.toThrow('browser has no bun:sqlite')
    await expect(testSite({ root, islands: false })).resolves.toBeDefined()
  })

  it('builds into a folder of its own, leaving what kay build wrote alone', async () => {
    await Bun.write(greeting, FINE)

    const listing = (): string[] => {
      try {
        return readdirSync(clientDir(root), { recursive: true }).map(String).sort()
      }
      catch {
        return []
      }
    }
    const before = listing()

    await testSite({ root, base: '/other' })

    expect(listing()).toEqual(before)
    // The server's own imports of an asset are written to `.kay/client` as before, the browser build's worker is not.
    const assets = (dir: string): string[] => existsSync(dir) ? readdirSync(dir) : []

    expect(assets(join(root, '.kay/client/dist/assets')).some(name => name.startsWith('echo-'))).toBe(false)
    expect(assets(join(checkDir(), 'dist/assets')).some(name => name.startsWith('echo-'))).toBe(true)
    expect(await Bun.file(manifest()).exists()).toBe(true)
    expect(await inOutput('elsewhere', async () => Promise.resolve(outputDir('/p')))).toBe('/p/.kay/elsewhere')
  })

  it('builds once for sources that did not change, and again for other options', async () => {
    await testSite({ root })

    const first = Bun.file(manifest()).lastModified

    // The rebuild, if it came, would have to be newer than the first manifest by a file time's granularity.
    await Bun.sleep(20)
    await testSite({ root })
    await testSite({ root, browser: false })

    expect(Bun.file(manifest()).lastModified).toBe(first)

    // The rebuild has to be newer than the first manifest by a file time's granularity.
    await Bun.sleep(20)
    await testSite({ root, base: '/app' })

    expect(Bun.file(manifest()).lastModified).toBeGreaterThan(first)
  })

  it('builds again for a source written outside src, as kay dev would', async () => {
    await testSite({ root })

    const first = Bun.file(manifest()).lastModified

    await Bun.sleep(20)
    await Bun.write(join(root, 'content/note.md'), '# Note\n')
    await testSite({ root })

    expect(Bun.file(manifest()).lastModified).toBeGreaterThan(first)
  })
})

// Ages every directory of the root's sources, as a fixture checked out a while ago has them: a directory written within two seconds before a walk cannot tell an entry added next by its stamp.
function settleDirectories(dir: string): void {
  const past = new Date(Date.now() - 60_000)

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== '.kay')
      settleDirectories(join(dir, entry.name))
  }

  utimesSync(dir, past, past)
}

describe('testSite keeps the islands it built', () => {
  it('walks nothing again while no source came, changed or went, and builds again for one that came', async () => {
    await Bun.write(greeting, FINE)
    await testSite({ root })
    settleDirectories(root)
    await testSite({ root })

    const walks = spyOn(files, 'projectTree')
    const first = Bun.file(manifest()).lastModified

    try {
      await Bun.sleep(20)
      await testSite({ root })
      expect(walks.mock.calls.filter(([dir]) => dir === root)).toEqual([])
      expect(Bun.file(manifest()).lastModified).toBe(first)

      await Bun.write(join(root, 'src/routes/other.kay'), 'p Other\n')
      await testSite({ root })
      expect(Bun.file(manifest()).lastModified).toBeGreaterThan(first)
    }
    finally {
      walks.mockRestore()
      rmSync(join(root, 'src/routes/other.kay'))
    }
  })

  it('builds nothing again for a file a test creates or removes that the .gitignore leaves out, and again for one it does not', async () => {
    await Bun.write(join(root, '.gitignore'), 'data/*.sqlite\n*.sqlite-wal\n')
    await testSite({ root })

    const first = Bun.file(manifest()).lastModified

    try {
      await Bun.sleep(20)
      await Bun.write(join(root, 'data/run-1.sqlite'), 'rows')
      await Bun.write(join(root, 'data/run-1.sqlite-wal'), 'log')
      await testSite({ root })
      rmSync(join(root, 'data/run-1.sqlite-wal'))
      await testSite({ root })
      expect(Bun.file(manifest()).lastModified).toBe(first)

      await Bun.write(join(root, 'data/seed.json'), '[]')
      await testSite({ root })
      expect(Bun.file(manifest()).lastModified).toBeGreaterThan(first)
    }
    finally {
      rmSync(join(root, '.gitignore'))
      rmSync(join(root, 'data'), { recursive: true, force: true })
    }
  })

  it('builds nothing again for a file no build reads that a test rewrites', async () => {
    await Bun.write(join(root, 'data/app.sqlite'), 'first')
    await testSite({ root })

    const first = Bun.file(manifest()).lastModified

    await Bun.sleep(20)
    await Bun.write(join(root, 'data/app.sqlite'), 'second, longer')
    await testSite({ root })
    expect(Bun.file(manifest()).lastModified).toBe(first)
  })
  it('fails again without building while no source changed after a build that failed, and builds once one did', async () => {
    const builds = spyOn(client, 'buildClient')

    try {
      await Bun.write(greeting, BROWSERLESS)
      await expect(testSite({ root })).rejects.toThrow('browser has no bun:sqlite')
      await expect(testSite({ root })).rejects.toThrow('browser has no bun:sqlite')
      expect(builds).toHaveBeenCalledTimes(1)

      await Bun.write(greeting, FINE)
      await expect(testSite({ root })).resolves.toBeDefined()
      expect(builds).toHaveBeenCalledTimes(2)
    }
    finally {
      builds.mockRestore()
    }
  })

  it('shares the build running with a site asked for meanwhile, and runs builds of other options one after the other', async () => {
    const buildClient = client.buildClient
    let running = 0
    let most = 0
    const builds = spyOn(client, 'buildClient').mockImplementation(async (...args) => {
      most = Math.max(most, ++running)

      try {
        return await buildClient(...args)
      }
      finally {
        running--
      }
    })

    try {
      await Bun.write(greeting, `${FINE}// shared\n`)
      await Promise.all([testSite({ root }), testSite({ root })])
      expect(builds).toHaveBeenCalledTimes(1)

      await Promise.all([testSite({ root, base: '/one' }), testSite({ root, base: '/two' })])
      expect(builds).toHaveBeenCalledTimes(3)
      expect(most).toBe(1)
    }
    finally {
      builds.mockRestore()
    }
  })
})

describe('testSite keeps its check between processes', () => {
  const visit = async (options: { base?: string } = {}): Promise<void> => {
    const code = `import { testSite } from ${JSON.stringify(join(import.meta.dir, '../src/test'))}\nawait testSite({ root: ${JSON.stringify(root)}, ...${JSON.stringify(options)} })\nawait Bun.sleep(300)\nprocess.exit(0)\n`
    const child = Bun.spawn([process.execPath, '-e', code], { cwd: root, stdout: 'ignore', stderr: 'pipe', env: { ...process.env, KAY_ROOT: root } })
    const [error, exit] = await Promise.all([new Response(child.stderr).text(), child.exited])

    if (exit !== 0)
      throw new Error(error)
  }
  const recorded = (): string => join(checkDir(), 'fingerprint.json')

  // The check builds the process leaves, by folder and the time their manifest was written.
  const manifests = (): Record<string, number> => Object.fromEntries(readdirSync(join(root, '.kay')).filter(name => name.startsWith(`test-client${testWorker()}.`)).map(name => [name, Bun.file(join(root, '.kay', name, 'manifest.json')).lastModified]))

  it('builds the islands once for the files of a run, and again once a source changed', async () => {
    for (const name of Object.keys(manifests()))
      rmSync(join(root, '.kay', name), { recursive: true, force: true })

    await Bun.write(greeting, FINE)
    await testSite({ root })
    // The record is written once the build settles.
    for (let wait = 0; wait < 100 && !existsSync(recorded()); wait++)
      await Bun.sleep(20)

    settleDirectories(root)
    // A first process meets the files the others just wrote within two seconds, which a record cannot trust: one more build leaves a settled one.
    await Bun.sleep(2100)
    await visit()
    await Bun.sleep(100)

    const first = Bun.file(manifest()).lastModified

    // The record holds kay's own runtime, which a checkout may edit under one version.
    const saved = await Bun.file(recorded()).json() as { stamps: Record<string, string> }

    expect(Object.keys(saved.stamps).some(file => file.endsWith(join('src', 'runtime', 'core.ts')))).toBe(true)
    await Bun.sleep(20)
    await visit()
    expect(Bun.file(manifest()).lastModified).toBe(first)

    await Bun.write(greeting, `${FINE}// changed\n`)
    await visit()
    expect(Bun.file(manifest()).lastModified).toBeGreaterThan(first)

    // A dependency bump shows only in the root manifests, which the build does not read; the edit above has to be settled first.
    await Bun.sleep(2100)
    await visit()

    const second = Bun.file(manifest()).lastModified

    await Bun.sleep(20)
    await visit()
    expect(Bun.file(manifest()).lastModified).toBe(second)
    await Bun.write(join(root, 'package.json'), '{ "name": "scratch", "version": "2.0.0" }\n')
    await visit()
    expect(Bun.file(manifest()).lastModified).toBeGreaterThan(second)
  })

  it('keeps one record per options key, so files alternating `base` build nothing again', async () => {
    await Bun.sleep(2100)
    await visit({ base: '/one' })
    await visit({ base: '/two' })
    await Bun.sleep(2100)
    await visit({ base: '/one' })
    await visit({ base: '/two' })

    const kept = manifests()

    expect(Object.keys(kept)).toHaveLength(3)
    await Bun.sleep(20)
    await visit({ base: '/one' })
    await visit()
    await visit({ base: '/two' })
    expect(manifests()).toEqual(kept)
  })

  it('builds again for a source added or deleted between processes, and once for each', async () => {
    const extra = join(root, 'src/extra.ts')
    const before = manifests()

    await Bun.write(extra, 'export const extra = 1\n')
    await visit()
    await Bun.sleep(2100)
    await visit()

    const added = manifests()

    expect(Object.values(added).some((time, index) => time > Object.values(before)[index]!)).toBe(true)
    await Bun.sleep(20)
    await visit()
    expect(manifests()).toEqual(added)

    rmSync(extra)
    await Bun.sleep(2100)
    await visit()
    await Bun.sleep(20)

    const removed = manifests()

    expect(Object.values(removed).some((time, index) => time > Object.values(added)[index]!)).toBe(true)
    await visit()
    expect(manifests()).toEqual(removed)
  })

  it('keeps no record of a .kay that does not compile, and a record again once it is gone', async () => {
    const index = join(root, 'src/routes/index.kay')
    const source = await Bun.file(index).text()

    await Bun.write(index, '---\nconst = \n---\nbutton {\n')
    await visit()
    expect(existsSync(recorded())).toBe(false)

    await Bun.write(index, source)
    await Bun.sleep(2100)
    await visit()
    await Bun.sleep(2100)
    await visit()
    expect(existsSync(recorded())).toBe(true)
  })
})
