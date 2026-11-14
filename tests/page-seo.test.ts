import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { isNoindexTag } from '../src/server/render-document'
import { kayBuild } from './check-helper'
import { fixtureCopy } from './scratch'

const NOINDEX = /name="robots" content="noindex"/

// The page as the export wrote it, `name.html` or `name/index.html`.
async function written(dir: string, name: string): Promise<string> {
  const flat = Bun.file(join(dir, `${name}.html`))

  return await flat.exists() ? flat.text() : Bun.file(join(dir, name, 'index.html')).text()
}

describe('page seo, cache and head shorthand', () => {
  it('writes the head of seo and of head(...) and the cache-control of cache, a block tag winning over a shorthand', async () => {
    const fixture = await fixtureCopy('static')
    const elsewhere = await mkdtemp(join(tmpdir(), 'kay-page-seo-'))

    try {
      await Promise.all([
        Bun.write(join(fixture, 'src/routes/hour.kay'), '--- server\nexport const page = { prerender: true, cache: \'1h\' }\n---\nh1 Hour\n'),
        Bun.write(join(fixture, 'src/routes/split.kay'), '--- server\nexport const page = { prerender: true, cache: { browser: \'5m\', shared: \'1h\', swr: \'10m\' } }\n---\nh1 Split\n'),
        Bun.write(join(fixture, 'src/routes/mine.kay'), '--- server\nexport const page = { prerender: true, cache: \'private\' }\n---\nh1 Mine\n'),
        Bun.write(join(fixture, 'src/routes/seo.kay'), '--- server\nexport const page = { prerender: true, seo: { title: \'Seo title\', description: \'Seo description\', canonical: \'https://example.com/elsewhere\', noindex: true } }\n---\nh1 Seo\n'),
        Bun.write(join(fixture, 'src/routes/short.kay'), 'head(title="Short title" description="Short description")\nh1 Short\n'),
        Bun.write(join(fixture, 'src/routes/wins.kay'), 'head(title="Shorthand title")\n  title Block title\nh1 Wins\n'),
        Bun.write(join(fixture, 'src/routes/block.kay'), 'head(description="Shorthand description" canonical="https://example.com/a" noindex)\n  meta(name="description" content="Block description")\n  link(rel="canonical" href="https://example.com/b")\n  meta(name="robots" content="index")\nh1 Block\n'),
        Bun.write(join(fixture, 'src/routes/hidden.kay'), '--- server\nconst hidden = true\n---\nhead(noindex={hidden})\nh1 Hidden\n'),
      ])

      const { code, output } = await kayBuild([fixture, '--no-check', '--static', '--outdir', elsewhere], { NODE_ENV: 'development' })

      expect(output).toBe('')
      expect(code).toBe(0)

      const headers = await Bun.file(join(elsewhere, '_headers')).text()

      expect(headers).toContain('\n/repo/hour\n  Cache-Control: public, max-age=0, s-maxage=3600, stale-while-revalidate=3600\n')
      expect(headers).toContain('\n/repo/split\n  Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=600\n')
      expect(headers).toContain('\n/repo/mine\n  Cache-Control: private\n')

      const seo = await written(elsewhere, 'seo')

      expect(seo).toContain('<title>Seo title</title>')
      expect(seo).toContain('name="description" content="Seo description"')
      expect(seo).toContain('rel="canonical" href="https://example.com/elsewhere"')
      expect(seo).toMatch(NOINDEX)

      const short = await written(elsewhere, 'short')

      expect(short).toContain('<title>Short title</title>')
      expect(short).toContain('name="description" content="Short description"')
      expect(short).not.toMatch(NOINDEX)
      expect(await written(elsewhere, 'wins')).toContain('<title>Block title</title>')
      expect(await written(elsewhere, 'hidden')).toMatch(NOINDEX)

      const block = await written(elsewhere, 'block')

      expect(block).toContain('content="Block description"')
      expect(block).not.toContain('Shorthand description')
      expect(block).toContain('href="https://example.com/b"')
      expect(block).not.toContain('https://example.com/a')
      expect(block).not.toMatch(NOINDEX)
    }
    finally {
      await rm(fixture, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('seo and cache along the layouts, the config and a wrong cache', () => {
  async function build(files: Record<string, string>, config?: string): Promise<{ code: number, output: string, dir: string, fixture: string }> {
    const fixture = await fixtureCopy('static')
    const dir = await mkdtemp(join(tmpdir(), 'kay-page-seo-'))

    await Promise.all(Object.entries(files).map(async ([name, text]) => Bun.write(join(fixture, 'src/routes', name), text)))

    if (config !== undefined) {
      const path = join(fixture, 'kay.config.ts')

      await Bun.write(path, (await Bun.file(path).text()).replace('base: \'/repo\',', `base: '/repo', ${config},`))
    }

    const { code, output } = await kayBuild([fixture, '--no-check', '--static', '--outdir', dir], { NODE_ENV: 'development' })

    return { code, output, dir, fixture }
  }

  it('a layout\'s seo and cache apply under it, the page\'s own winning', async () => {
    const built = await build({
      'inherit/_layout.kay': '--- server\nexport const page = { cache: \'1h\', seo: { noindex: true } }\n---\nslot\n',
      'inherit/child.kay': '--- server\nexport const page = { prerender: true }\n---\nh1 Child\n',
      'inherit/own.kay': '--- server\nexport const page = { prerender: true, cache: \'private\', seo: { noindex: false } }\n---\nh1 Own\n',
    })

    try {
      expect(built.code).toBe(0)

      const headers = await Bun.file(join(built.dir, '_headers')).text()

      expect(headers).toContain('\n/repo/inherit/child\n  Cache-Control: public, max-age=0, s-maxage=3600, stale-while-revalidate=3600\n')
      expect(headers).toContain('\n/repo/inherit/own\n  Cache-Control: private\n')
      expect(await written(built.dir, 'inherit/child')).toMatch(NOINDEX)
      expect(await written(built.dir, 'inherit/own')).not.toMatch(NOINDEX)
    }
    finally {
      await rm(built.fixture, { recursive: true, force: true })
      await rm(built.dir, { recursive: true, force: true })
    }
  })

  it('the config\'s seo.noindex adds the robots tag to every page, a page\'s seo.noindex false taking it back', async () => {
    const built = await build({
      'all.kay': 'h1 All\n',
      'open.kay': '--- server\nexport const page = { prerender: true, seo: { noindex: false } }\n---\nh1 Open\n',
    }, 'seo: { noindex: true }')

    try {
      expect(built.code).toBe(0)
      expect(await written(built.dir, 'all')).toMatch(NOINDEX)
      expect(await written(built.dir, 'open')).not.toMatch(NOINDEX)
    }
    finally {
      await rm(built.fixture, { recursive: true, force: true })
      await rm(built.dir, { recursive: true, force: true })
    }
  })

  it('a nested seo.sitemap false leaves the page out of the sitemap', async () => {
    const built = await build({
      'listed.kay': '--- server\nexport const page = { prerender: true }\n---\nh1 Listed\n',
      'unlisted.kay': '--- server\nexport const page = { prerender: true, seo: { sitemap: false } }\n---\nh1 Unlisted\n',
    })

    try {
      expect(built.code).toBe(0)

      const sitemap = await Bun.file(join(built.dir, 'sitemap.xml')).text()

      expect(sitemap).toContain('/listed')
      expect(sitemap).not.toContain('/unlisted')
    }
    finally {
      await rm(built.fixture, { recursive: true, force: true })
      await rm(built.dir, { recursive: true, force: true })
    }
  })

  it('refuses a cache that is not a duration, an object, private or false, naming the page and the forms', async () => {
    for (const cache of ['null', '\'soon\'', '5', '[]']) {
      const built = await build({ 'bad.kay': `--- server\nexport const page = { prerender: true, cache: ${cache} }\n---\nh1 Bad\n` })

      try {
        expect(built.code).not.toBe(0)
        expect(built.output).toContain('the `cache` of')
        expect(built.output).toContain('bad.kay')
        expect(built.output).toContain('`\'1h\'`, `{ browser, shared, swr }`, `\'private\'` or `false`')
      }
      finally {
        await rm(built.fixture, { recursive: true, force: true })
        await rm(built.dir, { recursive: true, force: true })
      }
    }
  })
})

describe('isNoindexTag', () => {
  const robots = (content: string) => ({ tag: 'meta', props: { name: 'robots', content } })

  it('matches a robots list holding noindex, in any case', () => {
    expect(isNoindexTag(robots('noindex'))).toBe(true)
    expect(isNoindexTag(robots('NoIndex, nofollow'))).toBe(true)
    expect(isNoindexTag(robots('nofollow,noindex'))).toBe(true)
    expect(isNoindexTag(robots('index, follow'))).toBe(false)
    expect(isNoindexTag({ tag: 'meta', props: { name: 'description', content: 'noindex' } })).toBe(false)
  })
})
