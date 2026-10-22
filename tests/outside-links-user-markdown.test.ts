import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { markdownHtml as islandMarkdown } from '../src/runtime/markdown-render.client'
import { markdownHtml } from '../src/runtime/markdown.server'
import { setSite } from '../src/runtime/site'

const OUT = ' target="_blank" rel="nofollow ugc noopener"'
const SOURCE = [
  '[away](https://other.example/a?x=1&y=2)',
  '[same](https://x.example/same)',
  '[root](/about)',
  '[hash](#top)',
  '[mail](mailto:a@other.example)',
  '[slashes](//evil.example/x)',
  '[userinfo](https://x.example@evil.example/)',
  '[suffix](https://x.example.evil.example/)',
  '[upper](HTTPS://Other.Example/up)',
  '[script](javascript:alert(1))',
  'https://auto.example/b',
  '<a href="https://other.example/raw" target="_self">raw</a>',
].join('\n\n')

function tag(html: string, href: string): string {
  return new RegExp(`<a [^>]*href="${href}"[^>]*>`).exec(html)?.[0] ?? ''
}

function expectSplit(html: string): void {
  expect(tag(html, 'https://other.example/a\\?x=1&amp;y=2')).toContain(OUT)
  expect(tag(html, 'HTTPS://Other.Example/up')).toContain(OUT)
  expect(tag(html, 'https://auto.example/b')).toContain(OUT)
  expect(tag(html, 'https://x.example@evil.example/')).toContain(OUT)
  expect(tag(html, 'https://x.example.evil.example/')).toContain(OUT)
  expect(tag(html, 'https://x.example/same')).toBe('<a href="https://x.example/same" rel="nofollow ugc">')
  expect(tag(html, '/about')).toBe('<a href="/about" rel="nofollow ugc">')
  expect(tag(html, '#top')).toBe('<a href="#top" rel="nofollow ugc">')
  expect(tag(html, 'mailto:a@other.example')).toBe('<a href="mailto:a@other.example" rel="nofollow ugc">')
  expect(html).not.toContain('javascript:')
  expect(html).not.toContain('evil.example/x')
  // A raw tag's own target is dropped by the sanitizer, and its link is outside like the rest.
  expect(tag(html, 'https://other.example/raw')).toContain(OUT)
  expect(html.match(/target=/g)?.length).toBe(html.match(/target="_blank" rel="nofollow ugc noopener"/g)?.length)
}

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://x.example/app/page/' })
})

afterAll(async () => {
  setSite(undefined)
  await GlobalRegistrator.unregister()
})

describe('markdownHtml links', () => {
  it('opens a link leaving the site in a new tab, on the server against the site origin', () => {
    setSite('https://x.example')
    expectSplit(markdownHtml(SOURCE))
  })

  it('does the same under trailingSlash always', () => {
    setSite('https://x.example', 'always')
    expectSplit(markdownHtml(SOURCE))
    setSite('https://x.example')
  })

  it('writes the same in an island, against location.origin', () => {
    setSite('https://x.example')
    expectSplit(islandMarkdown(SOURCE))
    expect(islandMarkdown(SOURCE)).toBe(markdownHtml(SOURCE))
  })

  it('takes any absolute link as leaving while the server knows no site', () => {
    setSite(undefined)
    expect(tag(markdownHtml(SOURCE), 'https://x.example/same')).toContain(OUT)
  })

  it('writes no target under links.outside same-tab, on the server and in an island', () => {
    setSite('https://x.example', undefined, false, true)
    expect(markdownHtml(SOURCE)).not.toContain('target=')
    expect(markdownHtml(SOURCE)).toContain('rel="nofollow ugc"')

    const meta = document.createElement('meta')

    meta.name = 'kay-same-tab-links'
    document.head.append(meta)
    expect(islandMarkdown(SOURCE)).not.toContain('target=')
    expect(islandMarkdown(SOURCE)).toBe(markdownHtml(SOURCE))
    meta.remove()
    setSite('https://x.example')
  })

  it('leaves text that only looks like a link alone', () => {
    setSite('https://x.example')
    expect(markdownHtml('see `<a href="https://other.example/">x</a>` and &lt;a href="https://o.example/"&gt;')).not.toContain('target=')
  })
})
