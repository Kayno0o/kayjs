import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { a11yProblem } from '../src/runtime/dev-a11y'
import { pages } from './shared-pages'

const ROUTES = 'tests/fixtures/bare/src/routes'

describe('the accessibility check of the dev server', () => {
  it('loads on its pages, axe-core coming from its own route', async () => {
    const app = new Elysia().use(await pages({ routes: ROUTES, prebuilt: true, dev: true }))

    expect(await (await app.handle(new Request('http://localhost/'))).text()).toContain('<script type="module" src="/_kay/dev/a11y.js"></script>')
    expect(await (await app.handle(new Request('http://localhost/_kay/dev/a11y.js'))).text()).toContain('startA11y()')

    const axe = await app.handle(new Request('http://localhost/_kay/dev/axe.js'))

    expect(axe.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await axe.text()).toStartWith('/*! axe v4.')
  })

  it('is no part of a server out of development', async () => {
    const app = new Elysia().use(await pages({ routes: ROUTES, prebuilt: true }))

    expect(await (await app.handle(new Request('http://localhost/'))).text()).not.toContain('/_kay/dev/a11y.js')
    expect((await app.handle(new Request('http://localhost/_kay/dev/a11y.js'))).status).toBe(404)
    expect((await app.handle(new Request('http://localhost/_kay/dev/axe.js'))).status).toBe(404)
  })

  it('logs each violation as a kay problem naming a few of its elements, inside a shadow root as well', () => {
    const nodes = [[['my-card', 'button']], ...Array.from({ length: 6 }, (_, index) => [`#b${index}`])].map(target => ({ target }))

    expect(a11yProblem({ id: 'button-name', help: 'Buttons must have discernible text', helpUrl: 'https://example.com/button-name', nodes })).toBe('[kay] a11y button-name: Buttons must have discernible text\n  my-card >>> button\n  #b0\n  #b1\n  #b2\n  #b3\n  and 2 more\nhttps://example.com/button-name')
  })
})
