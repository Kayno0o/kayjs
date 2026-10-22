import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { joinBase, withBase, withoutBase } from '../src/runtime/base'
import { rebaseHtml } from '../src/server/base'
import { pages } from './shared-pages'

// Apart from tests/static.test.ts, and not to run beside tests/i18n-links.test.ts in one process: `pages()` on the static fixture's routes puts the checkout's `.kay` loader in the process, and a process serves one project, so a test site of a copy fails there with the way out.
describe('base on a server', () => {
  it('puts a route starting like the base under it too, and rewrites srcset and inline styles', async () => {
    expect(joinBase('/blog', '/blog/hello')).toBe('/blog/blog/hello')
    expect(joinBase('/blog', '//cdn.example/x.js')).toBe('//cdn.example/x.js')
    expect(joinBase('/blog', 'relative.png')).toBe('relative.png')

    const html = await rebaseHtml(new Response('<img srcset="/a.webp 320w, /b.webp 640w"><style>body { background: url("/bg.png") }</style><object data="/x.svg"></object>'), '/repo').text()

    expect(html).toBe('<img srcset="/repo/a.webp 320w, /repo/b.webp 640w"><style>body { background: url("/repo/bg.png") }</style><object data="/repo/x.svg"></object>')
  })

  it('reads no mount point off a page on the server, where kay put the paths under it already', () => {
    expect(typeof document).toBe('undefined')
    expect(withBase('/about')).toBe('/about')
    expect(withoutBase('/repo/about')).toBe('/repo/about')
  })

  it('rewrites whole bodies through one rewriter per base without one page leaking into the next, and streams apart', async () => {
    const big = `<style>${'a{background:url("/bg.png")}'.repeat(10000)}</style>`
    const small = '<style>p{background:url(/s.png)}</style><a href="/x">x</a>'
    const expectedBig = `<style>${'a{background:url("/repo/bg.png")}'.repeat(10000)}</style>`

    for (let round = 0; round < 2; round++) {
      expect(await rebaseHtml(new Response(big), '/repo', true).text()).toBe(expectedBig)
      expect(await rebaseHtml(new Response(small), '/repo', true).text()).toBe('<style>p{background:url(/repo/s.png)}</style><a href="/repo/x">x</a>')
      expect(await rebaseHtml(new Response(small), '/other', true).text()).toBe('<style>p{background:url(/other/s.png)}</style><a href="/other/x">x</a>')
    }

    const stream = (text: string) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(text.slice(0, 40)))
      queueMicrotask(() => {
        controller.enqueue(new TextEncoder().encode(text.slice(40)))
        controller.close()
      })
    } }))

    const [first, second] = await Promise.all([rebaseHtml(stream(big), '/repo').text(), rebaseHtml(stream(small), '/repo').text()])

    expect(first).toBe(expectedBig)
    expect(second).toBe('<style>p{background:url(/repo/s.png)}</style><a href="/repo/x">x</a>')
  })

  it('puts an SVG xlink:href under the mount point as it does an href', async () => {
    const html = await rebaseHtml(new Response('<svg><use xlink:href="/sprite.svg#a"></use></svg>'), '/repo').text()

    expect(html).toBe('<svg><use xlink:href="/repo/sprite.svg#a"></use></svg>')
  })

  it('puts the links, assets and redirects of every page under the mount point', async () => {
    const app = new Elysia().use(await pages({ root: 'tests/fixtures/static', prebuilt: false, security: false, site: 'https://x.example', base: '/repo/', inlineStyles: false, redirects: { '/old': '/about' } }))
    const visit = async (path: string) => app.handle(new Request(`http://localhost${path}`))
    const about = await (await visit('/about')).text()

    expect(about).toContain('<a class="about" href="/repo/about" aria-current="page">About</a>')
    expect(about).toMatch(/<link rel="stylesheet" href="\/repo\/_kay\/[\w-]+\.css">/)
    expect((await visit('/old')).headers.get('location')).toBe('/repo/about')
    expect((await visit('/about/')).headers.get('location')).toBe('/repo/about')

    const favicon = new Elysia().use(await pages({ root: 'tests/fixtures/static', prebuilt: false, security: false, base: '/repo', favicon: 'tests/fixtures/static/src/hero.png' }))
    const manifest = await (await favicon.handle(new Request('http://localhost/manifest.webmanifest'))).json() as { start_url: string, icons: { src: string }[] }

    expect(manifest.start_url).toBe('/repo/')
    expect(manifest.icons[0]!.src).toBe('/repo/icon-192.png')
    // No seo.description, no description.
    expect(manifest).not.toHaveProperty('description')
    await expect(pages({ root: 'tests/fixtures/static', prebuilt: false, base: 'repo' })).rejects.toThrow('base is repo, which is no path such as /docs')
  })
})
