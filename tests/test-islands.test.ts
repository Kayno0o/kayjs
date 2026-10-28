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

const manifest = (): string => join(root, `.kay/test-client${testWorker()}/manifest.json`)

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
    expect(assets(join(root, `.kay/test-client${testWorker()}/dist/assets`)).some(name => name.startsWith('echo-'))).toBe(true)
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
