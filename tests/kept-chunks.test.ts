import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { outputDir } from '../src/build/assets'
import { buildClient } from '../src/build/client'
import { KEPT_BUILDS, keptDir, restoreKept, setAsideKept } from '../src/build/kept'
import { serveBuildFiles } from '../src/server/build-files'
import { MANIFEST, readClient } from '../src/server/client'
import { fixtureCopy, scratchDir } from './scratch'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const COUNTER = 'src/components/counter.kay'
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
const ISLAND_CHUNK = /^counter-[\da-z]+\.js$/

// Without the check unless the first argument is `check`.
async function build(root: string, ...args: string[]): Promise<{ code: number, errors: string }> {
  const checked = args[0] === 'check'
  const child = Bun.spawn([process.execPath, CLI, 'build', root, ...checked ? args.slice(1) : ['--no-check', ...args]], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
  const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

  return { code, errors }
}

// A copy of the deploy fixture that `kay build` can also check.
async function project(): Promise<string> {
  const root = await fixtureCopy('deploy')

  await Bun.write(join(root, 'tsconfig.json'), TSCONFIG)

  return root
}

// A deploy: the counter says another word, so its chunk gets another name.
async function deploy(root: string, word: string, ...args: string[]): Promise<string> {
  const file = join(root, COUNTER)

  await Bun.write(file, (await Bun.file(file).text()).replace(/^button\.counter\(.*\) \w+ /m, match => match.replace(/\) \w+ /, `) ${word} `)))
  expect((await build(root, ...args)).code).toBe(0)

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
    const root = await project()
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
    const root = await project()
    const names: string[] = []

    for (const word of ['One', 'Two', 'Three', 'Four', 'Five'])
      names.push(await deploy(root, word))

    expect(KEPT_BUILDS).toBe(3)
    expect(await chunksIn(root)).toEqual(names.slice(-KEPT_BUILDS - 1).sort())
    expect((await served(root, names[0]!)).status).toBe(404)
    expect((await served(root, names[1]!)).status).toBe(200)
  }, 180_000)

  it('are not pushed out by a build that changed nothing, nor kept twice when its name is the same', async () => {
    const root = await project()
    const first = await deploy(root, 'Alpha')
    const second = await deploy(root, 'Beta')

    for (let again = 0; again < KEPT_BUILDS + 1; again++)
      expect(await build(root)).toEqual({ code: 0, errors: '' })

    expect(await chunksIn(root)).toEqual([first, second].sort())
    expect(await chunkOf(root)).toBe(second)

    // The files in the kept folders are the earlier builds' alone: the build in place owns the name it rewrote.
    const kept = (await readdir(keptDir(outputDir(root)))).filter(name => (/^\d+$/).test(name))

    expect(kept).toHaveLength(1)
    expect(await chunksIn(root)).toContain(first)
  }, 180_000)

  it('survive a build that failed in between, and a deploy back to a build\'s code reuses its chunk name', async () => {
    const root = await project()
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
    const root = await project()

    await Bun.write(join(root, 'kay.config.ts'), 'export default { base: \'/app\' }\n')

    const first = await deploy(root, 'Alpha')

    await deploy(root, 'Beta')
    expect(await chunksIn(root)).toContain(first)
    expect((await served(root, first)).status).toBe(200)
    expect(keptDir(outputDir(root)).startsWith(`${outputDir(root)}/`)).toBe(false)
  }, 120_000)

  it('go into a static export too, where the host serves them beside the new build', async () => {
    const root = await project()
    const first = await deploy(root, 'Alpha')
    const out = join(root, 'out')

    await deploy(root, 'Beta', '--static', '--outdir', out)
    expect(existsSync(join(out, '_kay', first))).toBe(true)
    await rm(out, { recursive: true, force: true })
  }, 120_000)

  it('survive a build whose output stage failed after its manifest was written, with or without the check', async () => {
    for (const mode of [[], ['check']]) {
      const root = await project()
      const first = await deploy(root, 'Alpha', ...mode)
      const second = await deploy(root, 'Beta', ...mode)
      const page = join(root, 'src/routes/index.kay')
      const good = await Bun.file(page).text()

      // The bundle succeeds, then the prerender throws.
      await Bun.write(page, `--- server\nexport const page = { prerender: true }\nthrow new Error('no page today')\n---\n${good}`)
      const file = join(root, COUNTER)

      await Bun.write(file, (await Bun.file(file).text()).replace('Beta', 'Gamma'))
      expect((await build(root, ...mode)).code).not.toBe(0)
      await Bun.write(page, good)

      // Without the check the failed build stays in place with its chunk, which no server ever served; with it the last good build is put back.
      const failed = await chunkOf(root)

      expect(failed === second).toBe(mode.length > 0)

      const third = await deploy(root, 'Delta', ...mode)

      expect(await chunksIn(root)).toEqual(expect.arrayContaining([first, second, third]))
      expect((await chunksIn(root)).includes(failed)).toBe(mode.length > 0)
    }
  }, 240_000)

  it('stay through a build that failed the check, and the build after it', async () => {
    const root = await project()
    const first = await deploy(root, 'Alpha', 'check')
    const second = await deploy(root, 'Beta', 'check')

    await Bun.write(join(root, 'src/routes/lost.kay'), 'a(href="/nowhere") Lost\n')
    expect((await build(root, 'check')).code).toBe(1)
    await rm(join(root, 'src/routes/lost.kay'))
    expect(await chunksIn(root)).toEqual([first, second].sort())

    const third = await deploy(root, 'Gamma', 'check')

    expect(await chunksIn(root)).toEqual([first, second, third].sort())
    expect(existsSync(`${outputDir(root)}-previous`)).toBe(false)
  }, 180_000)

  it('stay out of an executable\'s growth: five deploys, then a compile, embed the build and the three before it', async () => {
    const root = await project()

    for (const word of ['One', 'Two', 'Three', 'Four'])
      await deploy(root, word)

    const last = await deploy(root, 'Five', '--compile', join(root, 'app'))
    const chunks = await chunksIn(root)

    expect(chunks).toHaveLength(KEPT_BUILDS + 1)
    expect(chunks).toContain(last)
    expect(existsSync(join(root, 'app'))).toBe(true)

    // Every chunk of the build in place is a file the executable embeds, by its name.
    const executable = Buffer.from(await Bun.file(join(root, 'app')).arrayBuffer())

    for (const chunk of chunks)
      expect(executable.includes(chunk)).toBe(true)
  }, 240_000)

  it('are kept by kay build alone: a client build as kay dev and the tests make leaves none aside', async () => {
    const root = resolve(await fixtureCopy('deploy'))

    await buildClient(root, { minify: true })
    await Bun.write(join(root, COUNTER), (await Bun.file(join(root, COUNTER)).text()).replace('Count', 'Total'))
    await buildClient(root, { minify: true })
    expect(await chunksIn(root)).toHaveLength(1)
    expect(existsSync(keptDir(outputDir(root)))).toBe(false)
  }, 60_000)
})

// A folder holding an output with a manifest and `dist` files, and the kept folder beside it.
async function output(dist: Record<string, string>, manifest = '{"build":1}'): Promise<string> {
  const dir = join(await scratchDir('kay-kept-'), '.kay-out')

  await mkdir(join(dir, 'dist'), { recursive: true })
  await Bun.write(join(dir, MANIFEST), manifest)

  for (const [name, text] of Object.entries(dist))
    await Bun.write(join(dir, 'dist', name), text)

  return dir
}

describe('the kept folders', () => {
  it('stage the chunks named by Bun\'s hash of a good build when the next one starts, never a hand-named script', async () => {
    const dir = await output({ 'counter-abcd1234.js': 'a', 'counter-abcd1234.js.br': 'a', 'my-component.js': 'b', 'my-widget-1.css': 'c', 'Counter-ABCD1234.js': 'd', 'assets/logo-xyz.png': 'e' })

    await restoreKept(dir)
    await setAsideKept(dir, `${dir}-previous`)
    expect((await readdir(join(keptDir(dir), 'next'), { recursive: true })).sort()).toEqual(['assets', 'assets/logo-xyz.png', 'counter-abcd1234.js', 'counter-abcd1234.js.br'])
  })

  it('stage nothing of a build that failed after its manifest, which no server served', async () => {
    const dir = await output({ 'counter-abcd1234.js': 'a' })

    await restoreKept(dir)
    await Bun.write(join(dir, MANIFEST), '{"build":2}')
    await Bun.write(join(dir, 'dist', 'counter-efgh5678.js'), 'b')
    await setAsideKept(dir, `${dir}-previous`)
    expect(existsSync(join(keptDir(dir), 'next'))).toBe(false)
  })

  it('give a build kept within the same millisecond as the one before a name of its own', async () => {
    const dir = await output({ 'new-aaaaaaaa.js': 'n' })
    const kept = keptDir(dir)

    await Bun.write(join(kept, '5000', 'old-bbbbbbbb.js'), 'o')
    await Bun.write(join(kept, 'next', 'prev-cccccccc.js'), 'p')
    await restoreKept(dir, 5000)
    expect((await readdir(kept)).filter(name => (/^\d+$/).test(name)).sort()).toEqual(['5000', '5001'])
    expect(await Bun.file(join(kept, '5001', 'prev-cccccccc.js')).text()).toBe('p')
    expect(await Bun.file(join(dir, 'dist', 'old-bbbbbbbb.js')).text()).toBe('o')
  })

  it('take a leftover set-aside folder from a killed run as the newest kept build, dropping what the new build rewrote', async () => {
    const dir = await output({ 'same-dddddddd.js': 'new' })
    const kept = keptDir(dir)

    await Bun.write(join(kept, 'next', 'same-dddddddd.js'), 'killed')
    await Bun.write(join(kept, 'next', 'gone-eeeeeeee.js'), 'g')
    await restoreKept(dir, 7000)
    expect(existsSync(join(kept, 'next'))).toBe(false)
    expect(await readdir(join(kept, '7000'))).toEqual(['gone-eeeeeeee.js'])
    expect(await Bun.file(join(dir, 'dist', 'same-dddddddd.js')).text()).toBe('new')
  })
})
