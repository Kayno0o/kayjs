import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
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
    }
    finally {
      await rm(fixture, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })
})
