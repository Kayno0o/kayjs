import { existsSync } from 'node:fs'
import { appendFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { fixtureCopy } from './scratch'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const SERVER = 'import process from \'node:process\'\nimport { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nconst app = new Elysia().use(await pages()).listen(Number(process.env.PORT ?? 0))\n\nconsole.log(`listening ${app.server?.port}`)\n'
// A class only a leftover output names: it reaches the stylesheet only when the build reads that output as a source.
const PLANTED = 'bg-[#a1b2c3]'
const RULE = 'a1b2c3'

let root = ''

async function build(...args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

  expect({ code, errors }).toEqual({ code: 0, errors: '' })
}

async function stylesheets(): Promise<string> {
  const dir = join(root, '.kay', 'client', 'dist')

  return (await Promise.all((await readdir(dir)).filter(name => name.endsWith('.css')).map(async name => Bun.file(join(dir, name)).text()))).join('\n')
}

beforeAll(async () => {
  root = resolve(await fixtureCopy('page-styles'))
  await Bun.write(join(root, 'kay.config.ts'), 'import tailwind from \'bun-plugin-tailwind\'\n\nexport default { plugins: [tailwind] }\n')
  await Bun.write(join(root, 'src/server.ts'), SERVER)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('a build never reads its own outputs as sources', () => {
  it('leaves the executable an earlier --compile wrote out of Tailwind\'s scan', async () => {
    await build('--compile', join(root, 'bin/server'))
    expect(await stylesheets()).not.toContain(RULE)

    await appendFile(join(root, 'bin/server'), `\nclass="${PLANTED}"\n`)
    await build('--compile', join(root, 'bin/server'))

    expect(await stylesheets()).not.toContain(RULE)
    expect(existsSync(join(root, 'bin/server'))).toBe(true)
  }, 120_000)

  it('leaves the site an earlier --static export wrote out of Tailwind\'s scan, in a custom folder too', async () => {
    await build('--static', '--outdir', join(root, 'out'))
    await Bun.write(join(root, 'out/planted.html'), `<p class="${PLANTED}">planted</p>`)
    await build('--static', '--outdir', join(root, 'out'))

    expect(await stylesheets()).not.toContain(RULE)
    expect(existsSync(join(root, 'out/index.html'))).toBe(true)
    expect(existsSync(join(root, 'out/planted.html'))).toBe(false)
  }, 120_000)
})
