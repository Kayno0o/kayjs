import type { ClientBuild } from '../src/server/client'
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { modeOf, resolveProject } from '../src/project'
import { servePages } from '../src/server/app'
import { listeningPort } from './listening'
import { fixtureCopy } from './scratch'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const ROUTES = 34
// The static export and the executable only need copies written and served, which a few routes over the inline limit prove as well as the cap's 34.
const FEW = 3
// Pages with as many more rules of their own as save the least, so the cap leaves exactly these linking the shared stylesheet.
const HEAVY = new Set([32, 33])
const CAP = 32
const COPY = /\/_kay\/[^"'\s]+\.r-[a-z0-9]+\.css/g
const SERVER = 'import process from \'node:process\'\nimport { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nconst app = new Elysia().use(await pages()).listen(Number(process.env.PORT ?? 0))\n\nconsole.log(`listening ${app.server?.port}`)\n'

// Many arbitrary values, each its own rule, so a page's own rules pass what its head may inline.
const bulk = (seed: number, count: number) => Array.from({ length: count }, (_, index) => `bg-[#${(((index + seed) * 2654435761) >>> 8).toString(16).padStart(6, '0').slice(0, 6)}] p-[${index + 3 + seed}px]`).join(' ')

let root = ''
let few = ''
let client: ClientBuild

// Route sets with rules of their own, `count` of them: more than the cap allows for the cap case, a few for the cases that build.
async function manyRoutes(count: number): Promise<string> {
  const dir = resolve(await fixtureCopy('page-styles'))

  for (let index = 0; index < count; index++)
    await Bun.write(join(dir, `src/routes/many-${index}.kay`), `h1 Many ${index}\np(class="${bulk(index * 10_000, count === ROUTES && HEAVY.has(index) ? 2400 : 1800)}") rules\n`)

  await Bun.write(join(dir, 'kay.config.ts'), 'import tailwind from \'bun-plugin-tailwind\'\n\nexport default { plugins: [tailwind] }\n')
  await Bun.write(join(dir, 'src/server.ts'), SERVER)

  return dir
}

async function copiesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter(name => (/\.r-[a-z0-9]+\.css$/).test(name)).sort()
}

// The copies a page links, by file name.
function linked(html: string): string[] {
  return [...html.matchAll(COPY)].map(match => match[0].slice('/_kay/'.length))
}

beforeAll(async () => {
  root = await manyRoutes(ROUTES)
  few = await manyRoutes(FEW)
  client = await buildClient(root, { plugins: [tailwind] })
}, 240_000)

afterAll(async () => {
  await Promise.all([rm(root, { recursive: true, force: true }), rm(few, { recursive: true, force: true })])
})

async function build(...args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, CLI, 'build', few, '--no-check', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

  expect({ code, errors }).toEqual({ code: 0, errors: '' })
}

describe('the copies of a stylesheet a build writes', () => {
  it('keep the 32 saving the most when more routes qualify, the others linking the shared stylesheet', async () => {
    const app = await servePages(resolveProject(root, { routes: 'src/routes', compress: false }, modeOf({ dev: false, prebuilt: true })), () => ({ ...client, styles: new Map(client.styles), inlineStyles: undefined, inlineSizes: undefined, pageStyles: undefined }))
    const html = async (index: number) => (await app.handle(new Request(`http://localhost/many-${index}`))).text()
    const heads = await Promise.all(Array.from({ length: ROUTES }, async (_, index) => html(index)))
    const written = await copiesIn(client.dir)

    expect(written).toHaveLength(CAP)

    for (const [index, page] of heads.entries()) {
      const copies = linked(page)

      if (HEAVY.has(index)) {
        expect(copies, `many-${index}`).toEqual([])
        expect(page).toMatch(/<link rel="stylesheet" href="\/_kay\/[^"]+\.css"/)
      }
      else {
        expect(copies, `many-${index}`).toHaveLength(1)
        expect(written).toContain(copies[0]!)
      }
    }
  }, 120_000)

  it('are all in a static export, beside the shared stylesheet', async () => {
    const out = join(few, 'out')

    await build('--static', '--outdir', out)

    const exported = await copiesIn(join(out, '_kay'))
    const links = new Set<string>()

    for (let index = 0; index < FEW; index++) {
      const nested = join(out, `many-${index}`, 'index.html')

      for (const copy of linked(await Bun.file(existsSync(nested) ? nested : join(out, `many-${index}.html`)).text()))
        links.add(copy)
    }

    expect(links.size).toBe(FEW)
    // The export also carries the copies of the builds kept beside the last one.
    for (const copy of links)
      expect(exported, copy).toContain(copy)
  }, 240_000)

  it('are all served by a compiled executable', async () => {
    const executable = join(few, 'bin/server')

    await build('--compile', executable)

    const child = Bun.spawn([executable], { cwd: few, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production', PORT: '0' } })

    try {
      const origin = `http://localhost:${await listeningPort(child, 'the executable')}`
      const links = new Set<string>()

      for (let index = 0; index < FEW; index++) {
        for (const copy of linked(await (await fetch(`${origin}/many-${index}`)).text()))
          links.add(copy)
      }

      expect(links.size).toBe(FEW)

      const built = resolveProject(few, { routes: 'src/routes' }, modeOf({ dev: false, prebuilt: true })).paths.client

      for (const copy of links) {
        const answer = await fetch(`${origin}/_kay/${copy}`)

        expect(answer.status, copy).toBe(200)
        expect(await answer.text(), copy).toBe(await Bun.file(join(built, copy)).text())
      }
    }
    finally {
      child.kill()
      await child.exited
    }
  }, 300_000)
})
