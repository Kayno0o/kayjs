import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { describe, expect, it } from 'bun:test'
import { pages } from '../src/server'

const app = await pages({ routes: 'tests/fixtures/site/src/routes' })
const MARKERS = /<!--[$/]-->/g
const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/
const ENTRY = /<script type="module" src="\/_kay\/([^"]+)"><\/script>/
const BODY = /<body>([\s\S]*)<\/body>/

async function get(path: string): Promise<{ status: number, html: string, headers: Headers }> {
  const response = await app.handle(new Request(`http://localhost${path}`))

  return { status: response.status, html: (await response.text()).replace(MARKERS, ''), headers: response.headers }
}

describe('pages', () => {
  it('renders a page inside its layout with server data typed into the template', async () => {
    const { status, html, headers } = await get('/')

    expect(status).toBe(200)
    expect(headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(html).toStartWith('<!doctype html><html lang="en"><head>')
    expect(html).toContain('<header><a href="/">Kay demo</a></header><main>')
    expect(html).toContain('<article class="card"><h2>Todos</h2><p>1 open</p><ul>')
    expect(html).toContain('<li><a href="/todos/2">Serve pages</a></li>')
  })

  it('ships the hydration script and the island bundle only to pages with islands', async () => {
    const home = await get('/')

    expect(home.html).toContain('<kay-island data-component="tests/fixtures/site/src/components/counter.kay"')
    expect(home.html).toContain('window._$HY')
    expect(home.html).toMatch(/<kay-island [^>]+><button _hk=k\w+-0 class="counter">/)
    expect(home.html.replace(/<kay-island[\s\S]*<\/kay-island>/, '')).not.toContain('_hk=')
    const entry = (/<script type="module" src="(\/_kay\/[^"]+)"><\/script>/).exec(home.html)?.[1]

    expect(entry).toBeDefined()
    const bundle = await app.handle(new Request(`http://localhost${entry}`))

    expect(bundle.status).toBe(200)
    expect(await bundle.text()).toContain('counter.kay')

    const about = await get('/about')

    expect(about.html).toContain('<h1>About</h1>')
    expect(about.html).not.toContain('<script')
  })

  it('passes route params and honours notFound and redirect', async () => {
    expect((await get('/todos/1')).html).toContain('<h1>Write the compiler</h1><p class="status">Done</p>')
    expect((await get('/todos/9')).status).toBe(404)
    const redirected = await app.handle(new Request('http://localhost/todos/nope'))

    expect(redirected.status).toBe(302)
    expect(redirected.headers.get('location')).toBe('/')
  })

  it('binds a catch-all segment', async () => {
    expect((await get('/docs/guide/intro')).html).toContain('<p class="path">Docs at guide/intro</p>')
  })

  it('refuses asset paths outside the client build', async () => {
    expect((await app.handle(new Request('http://localhost/_kay/..%2F..%2Fpackage.json'))).status).toBe(404)
  })

  it('hydrates the island on the served page and leaves the static markup alone', async () => {
    const html = await (await app.handle(new Request('http://localhost/'))).text()

    GlobalRegistrator.register()

    try {
      // Solid's bootstrap assigns `_$HY` on globalThis, which outlives happy-dom's window between test files.
      delete (globalThis as { _$HY?: unknown })._$HY
      // eslint-disable-next-line no-new-func -- runs Solid's inline bootstrap script, which happy-dom does not execute from markup
      new Function(INLINE_SCRIPT.exec(html)![1]!)()
      document.body.innerHTML = BODY.exec(html)![1]!
      const button = document.querySelector('kay-island button')!
      const card = document.querySelector('article.card')!

      await import(join(process.cwd(), '.kay/client/dist', ENTRY.exec(html)![1]!))
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(document.querySelector('kay-island button')).toBe(button)
      button.dispatchEvent(new Event('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(button.textContent).toBe('Clicked 2')
      expect(document.querySelector('article.card')).toBe(card)
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })
})
