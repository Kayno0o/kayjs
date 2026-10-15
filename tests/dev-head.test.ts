import type { DevHead } from '../src/server/dev'
import { join, relative } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { pages } from '../src/server'
import { DEV_HEAD } from '../src/server/dev'
import { scratchDir } from './scratch'

const HEAD = /<head>([\s\S]*)<\/head>/
const LONG = 'A sentence about the shop that goes on and on '.repeat(5)

async function site() {
  const dir = await scratchDir('dev-head-')

  await Promise.all([
    Bun.write(join(dir, 'routes/index.kay'), 'head\n  title Home\n  meta(name="description" content="The shop")\nh1 Home\n'),
    Bun.write(join(dir, 'routes/long.kay'), `head\n  title Long\n  meta(name="description" content="${LONG}")\n  meta(name="robots" content="noindex")\nh1 Long\n`),
    Bun.write(join(dir, 'routes/bare.kay'), 'h1 Bare\n'),
    Bun.write(join(dir, 'routes/hidden.kay'), '--- server\nexport const page = { sitemap: false }\n---\nh1 Hidden\n'),
  ])

  return relative(process.cwd(), join(dir, 'routes'))
}

async function askAbout(options: Parameters<typeof pages>[0], path: string, headers: Record<string, string> = { 'x-kay-dev': '1' }): Promise<{ status: number, head?: DevHead | undefined }> {
  const dev = await pages({ prebuilt: false, security: false, dev: true, ...options })
  const page = await (await dev.handle(new Request(`http://localhost${path}`))).text()
  const response = await dev.handle(new Request(`http://localhost${DEV_HEAD}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ path, head: `<head>${HEAD.exec(page)![1]}</head>` }) }))

  return { status: response.status, head: response.ok ? await response.json() as DevHead : undefined }
}

describe('the dev tool\'s head check', () => {
  it('says whether the sitemap lists the page and what `kay check` flags in its head, with the origin and the limit', async () => {
    const routes = await site()
    const options = { routes, site: 'https://shop.example', seo: { name: 'Shop', description: 'A shop' } }
    const home = (await askAbout(options, '/')).head!

    expect(home).toMatchObject({ descriptionLength: 160, site: 'https://shop.example', sitemap: 'listed' })
    expect(home.problems.map(problem => problem.code)).toEqual([])

    const long = (await askAbout(options, '/long')).head!

    expect(long.sitemap).toBe('listed')
    expect(long.problems.map(problem => problem.code)).toEqual(['long-description', 'noindex-in-sitemap'])
    expect((await askAbout(options, '/hidden')).head!.sitemap).toBe('unlisted')
    expect((await askAbout({ routes, site: options.site }, '/bare')).head!.problems.map(problem => problem.code)).toEqual(['untitled-page', 'undescribed-page'])
  })

  it('says there is no sitemap without an origin, and that the origin is missing when `seo` is set', async () => {
    const routes = await site()
    const { head } = await askAbout({ routes, seo: { name: 'Shop' } }, '/')

    expect(head).toMatchObject({ sitemap: 'none' })
    expect(head!.site).toBeUndefined()
    expect(head!.problems.map(problem => problem.code)).toContain('missing-site')
    expect((await askAbout({ routes }, '/')).head!.problems).toEqual([])
  })

  it('refuses a request the dev tool did not make', async () => {
    const routes = await site()

    expect((await askAbout({ routes }, '/', {})).status).toBe(403)
    expect((await askAbout({ routes }, '/', { 'x-kay-dev': '1', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
  })
})
