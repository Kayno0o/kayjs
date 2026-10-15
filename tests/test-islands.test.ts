import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { clientDir, inOutput, outputDir, testWorker } from '../src/build/assets'
import { testSite } from '../src/test'
import { scratchDir } from './scratch'

const ISLAND = '---\nimport { hello } from \'./greeting\'\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(count() + 1)}) {hello()} {count()}\n'
const BROWSERLESS = 'import { Database } from \'bun:sqlite\'\nexport const hello = () => String(Database.name)\n'
const FINE = 'export const hello = () => \'hi\'\n'

// One process serves one project, so every test of this file edits this one.
let root = ''
let greeting = ''

const manifest = (): string => join(root, `.kay/test-client${testWorker()}/manifest.json`)

beforeAll(async () => {
  root = await scratchDir('test-islands-')
  greeting = join(root, 'src/greeting.ts')
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
    expect(await Bun.file(manifest()).exists()).toBe(true)
    expect(await inOutput('elsewhere', async () => Promise.resolve(outputDir('/p')))).toBe('/p/.kay/elsewhere')
  })

  it('builds once for sources that did not change, and again for other options', async () => {
    await testSite({ root })

    const first = Bun.file(manifest()).lastModified

    await Bun.sleep(20)
    await testSite({ root })
    await testSite({ root, browser: false })

    expect(Bun.file(manifest()).lastModified).toBe(first)

    await Bun.sleep(20)
    await testSite({ root, base: '/app' })

    expect(Bun.file(manifest()).lastModified).toBeGreaterThan(first)
  })
})
