import type { I18nConfig } from '../src/config'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { Elysia } from 'elysia'
import { kayBuild } from './check-helper'
import { fixtureCopy } from './scratch'
import { pages } from './shared-pages'

setDefaultTimeout(60_000)

const SITE = 'https://x.example'
const HREF = /<a\b[^>]*?\shref="([^"]*)"/g
const PAGES = ['/about', '/news/hello', '/news/launch']

interface Variant {
  name: string
  base?: string
  trailingSlash?: 'always' | 'never'
  prefixDefault?: boolean
}

const VARIANTS: Variant[] = [
  { name: 'the default locale unprefixed and another one prefixed' },
  { name: 'every locale prefixed', prefixDefault: true },
  { name: 'a base', base: '/repo' },
  { name: 'trailingSlash always', trailingSlash: 'always' },
  { name: 'a base, every locale prefixed and trailingSlash never', base: '/repo', prefixDefault: true, trailingSlash: 'never' },
]

function hrefs(html: string): string[] {
  return [...html.matchAll(HREF)].map(match => match[1]!)
}

// What a static host would answer for the path: the file the export wrote for it.
async function exported(dir: string, path: string): Promise<string> {
  for (const candidate of [join(path, 'index.html'), `${path}.html`]) {
    try {
      return await readFile(join(dir, candidate), 'utf8')
    }
    catch {}
  }

  throw new Error(`the export has no page for ${path}`)
}

describe('kay build --static localizes links as the server render does', () => {
  for (const variant of VARIANTS) {
    it(`on ${variant.name}`, async () => {
      const copy = await fixtureCopy('static-locales')
      const base = variant.base ?? ''
      const i18n: I18nConfig = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'src/messages', ...variant.prefixDefault !== undefined && { prefixDefault: variant.prefixDefault } }
      const options = { site: SITE, ...variant.base !== undefined && { base: variant.base }, ...variant.trailingSlash !== undefined && { trailingSlash: variant.trailingSlash } }
      const config = `export default ${JSON.stringify({ ...options, favicon: false, i18n: { ...i18n, messages: 'src/messages' } })}\n`

      await Bun.write(join(copy, 'kay.config.ts'), config)

      const { code, output: errors } = await kayBuild([copy, '--no-check', '--static', '--outdir', join(copy, 'dist')], { NODE_ENV: 'development' })

      expect(errors).toBe('')
      expect(code).toBe(0)

      const served = new Elysia().use(await pages({ root: copy, prebuilt: false, security: false, i18n, ...options }))
      const slash = variant.trailingSlash === 'always' ? '/' : ''

      for (const locale of [variant.prefixDefault === true ? '/fr' : '', '/en']) {
        for (const path of PAGES) {
          // A host in front of the app strips the base from what it asks.
          const url = `${locale}${path}${slash}`
          const response = await served.handle(new Request(`http://localhost${url}`))
          const html = await exported(join(copy, 'dist'), `${locale}${path}`)

          expect(response.status).toBe(200)
          expect(hrefs(html)).toEqual(hrefs(await response.text()))
        }
      }

      // A page sending the browser on names the default locale as its language.
      const refreshes = (await Array.fromAsync(new Bun.Glob('**/*.html').scan(join(copy, 'dist')))).filter(file => file.endsWith('.html'))
      const sending = (await Promise.all(refreshes.map(async file => Bun.file(join(copy, 'dist', file)).text()))).filter(html => html.includes('http-equiv="refresh"'))

      expect(sending.length > 0 || variant.prefixDefault !== true).toBe(true)

      for (const html of sending)
        expect(html).toStartWith('<!doctype html><html lang="fr">')

      // Not vacuously: the English copy of a page links the English copies of its siblings, and what is no page, another site's or a locale's own stays as written.
      const english = hrefs(await exported(join(copy, 'dist'), '/en/about'))

      expect(english).toContain(`${base}/en/about`)
      expect(english).toContain(`${base}/en/news/launch`)
      expect(english).toContain(`${base}/en/about#team`)
      expect(english).toContain(`${base}/api/ping`)
      expect(english).toContain('https://example.com/about')
      // A link naming its own language stays as written.
      expect(english.at(-1)).toBe(`${base}/about`)
    })
  }
})
