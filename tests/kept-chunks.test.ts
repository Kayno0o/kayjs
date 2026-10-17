import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { outputDir } from '../src/build/assets'
import { buildClient } from '../src/build/client'
import { KEPT_BUILDS, keptDir } from '../src/build/kept'
import { serveBuildFiles } from '../src/server/build-files'
import { readClient } from '../src/server/client'
import { fixtureCopy } from './scratch'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const COUNTER = 'src/components/counter.kay'
const ISLAND_CHUNK = /^counter-[\da-z]+\.js$/

async function build(root: string, ...args: string[]): Promise<{ code: number, errors: string }> {
  const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
  const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

  return { code, errors }
}

// A deploy: the counter says another word, so its chunk gets another name.
async function deploy(root: string, word: string, ...args: string[]): Promise<string> {
  const file = join(root, COUNTER)

  await Bun.write(file, (await Bun.file(file).text()).replace(/^button\.counter\(.*\) \w+ /m, match => match.replace(/\) \w+ /, `) ${word} `)))
  expect(await build(root, ...args)).toEqual({ code: 0, errors: '' })

  return chunkOf(root)
}

async function chunksIn(root: string): Promise<string[]> {
  return (await readdir(join(outputDir(root), 'dist'))).filter(name => ISLAND_CHUNK.test(name)).sort()
}

// The island chunk the manifest of the build in place names.
async function chunkOf(root: string): Promise<string> {
  const client = await readClient(resolve(root))
  const chunk = Object.values(client!.islands).flat().find(url => (/\/counter-/).test(url))

  return chunk!.split('/').pop()!
}

async function served(root: string, name: string): Promise<Response> {
  const client = (await readClient(resolve(root)))!
  const app = new Elysia()

  await serveBuildFiles(app, client, { dev: false, security: undefined })

  return app.handle(new Request(`http://localhost/_kay/${name}`))
}

describe('the chunks of earlier builds', () => {
  it('stay beside the new build and are served, as are their compressed copies', async () => {
    const root = await fixtureCopy('deploy')
    const first = await deploy(root, 'Alpha')
    const second = await deploy(root, 'Beta')

    expect(second).not.toBe(first)
    expect(await chunksIn(root)).toEqual([first, second].sort())

    const old = await served(root, first)

    expect(old.status).toBe(200)
    expect(old.headers.get('cache-control')).toContain('immutable')
    expect(await old.text()).toContain('Alpha')
    expect(existsSync(join(outputDir(root), 'dist', `${first}.br`))).toBe(true)
    expect((await served(root, second)).status).toBe(200)
  }, 120_000)

  it('go after KEPT_BUILDS deploys, the oldest first, the new build and the kept ones all listed in the build\'s files', async () => {
    const root = await fixtureCopy('deploy')
    const names: string[] = []

    for (const word of ['One', 'Two', 'Three', 'Four', 'Five'])
      names.push(await deploy(root, word))

    expect(KEPT_BUILDS).toBe(3)
    expect(await chunksIn(root)).toEqual(names.slice(-KEPT_BUILDS - 1).sort())
    expect((await served(root, names[0]!)).status).toBe(404)
    expect((await served(root, names[1]!)).status).toBe(200)
  }, 180_000)

  it('are not pushed out by a build that changed nothing, nor kept twice when its name is the same', async () => {
    const root = await fixtureCopy('deploy')
    const first = await deploy(root, 'Alpha')
    const second = await deploy(root, 'Beta')

    for (let again = 0; again < KEPT_BUILDS + 1; again++)
      expect(await build(root)).toEqual({ code: 0, errors: '' })

    expect(await chunksIn(root)).toEqual([first, second].sort())
    expect(await chunkOf(root)).toBe(second)

    // The files in the kept folders are the earlier builds' alone: the build in place owns the name it rewrote.
    const kept = await readdir(keptDir(outputDir(root)))

    expect(kept).toHaveLength(1)
    expect(await chunksIn(root)).toContain(first)
  }, 180_000)

  it('survive a build that failed in between, and a deploy back to a build\'s code reuses its chunk name', async () => {
    const root = await fixtureCopy('deploy')
    const first = await deploy(root, 'Alpha')
    const second = await deploy(root, 'Beta')
    const file = join(root, COUNTER)
    const good = await Bun.file(file).text()

    await Bun.write(file, '---\nconst x = (\n---\nbutton Broken\n')
    expect((await build(root)).code).not.toBe(0)
    await Bun.write(file, good)
    expect((await build(root)).code).toBe(0)
    expect(await chunksIn(root)).toEqual([first, second].sort())

    // Back to the first words: that chunk is the build's own again, once.
    const back = await deploy(root, 'Alpha')

    expect(back).toBe(first)
    expect(await chunksIn(root)).toEqual([first, second].sort())
    expect((await served(root, second)).status).toBe(200)
  }, 180_000)

  it('stay when the build ends at a base, and sit beside the output, which an executable embeds whole, not in it', async () => {
    const root = await fixtureCopy('deploy')

    await Bun.write(join(root, 'kay.config.ts'), 'export default { base: \'/app\' }\n')

    const first = await deploy(root, 'Alpha')

    await deploy(root, 'Beta')
    expect(await chunksIn(root)).toContain(first)
    expect(keptDir(outputDir(root)).startsWith(`${outputDir(root)}/`)).toBe(false)
  }, 120_000)

  it('go into a static export too, where the host serves them beside the new build', async () => {
    const root = await fixtureCopy('deploy')
    const first = await deploy(root, 'Alpha')
    const out = join(root, 'out')

    await deploy(root, 'Beta', '--static', '--outdir', out)
    expect(existsSync(join(out, '_kay', first))).toBe(true)
    await rm(out, { recursive: true, force: true })
  }, 120_000)

  it('are kept by kay build alone: a client build as kay dev and the tests make leaves none aside', async () => {
    const root = resolve(await fixtureCopy('deploy'))

    await buildClient(root, { minify: true })
    await Bun.write(join(root, COUNTER), (await Bun.file(join(root, COUNTER)).text()).replace('Count', 'Total'))
    await buildClient(root, { minify: true })
    expect(await chunksIn(root)).toHaveLength(1)
    expect(existsSync(keptDir(outputDir(root)))).toBe(false)
  }, 60_000)
})
