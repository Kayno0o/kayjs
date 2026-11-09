import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from './shared-pages'

const MARKED = /<a class="([\w-]+)"[^>]*? aria-current="(\w+)"/g

// The classes of the links of an island a page marks, each with its mark.
async function marks(site: Elysia, path: string): Promise<string[]> {
  const html = await (await site.handle(new Request(`http://localhost${path}`))).text()

  return [...html.matchAll(MARKED)].map(([, name, mark]) => `${name}:${mark}`)
}

describe('the links of an island', () => {
  it.each([
    ['production', {}, ''],
    ['dev', { dev: true }, ''],
    ['a base and a trailing slash', { base: '/repo', trailingSlash: 'always' as const }, '/'],
  ])('are marked in the server HTML as those of a page are, in %s', async (_name, options, slash) => {
    const site = new Elysia().use(await pages({ root: 'tests/fixtures/current-island', prebuilt: false, security: false, ...options }))

    expect(await marks(site, '/')).toEqual(['m-home:page', 'm-own:false'])
    expect(await marks(site, `/docs${slash}`)).toEqual(['m-docs:page', 'm-own:false'])
    expect(await marks(site, `/docs/guide${slash}`)).toEqual(['m-docs:true', 'm-guide:page', 'm-own:false'])
  })
})
