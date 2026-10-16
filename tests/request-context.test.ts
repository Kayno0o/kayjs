import { rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { stringify } from 'devalue'
import { pages } from '../src/server'
import { scratchDir } from './scratch'

// What a guard, an endpoint and an action do from the `x-do` header, so one handler answers every case.
const STOP = `  const todo = request.headers.get('x-do')\n\n  if (todo === 'redirect')\n    redirect('/elsewhere')\n\n  if (todo === 'redirect-301')\n    redirect('/moved', 301)\n\n  if (todo === 'deny')\n    deny(402, 'Pay first')\n\n  if (todo === 'not-found')\n    notFound()\n`
const GUARD = `import { guard } from 'kay'\n\nexport default guard(({ request, url, locale, params, cookies, headers, redirect, deny, notFound }) => {\n${STOP}\n  headers.set('x-seen', \`\${locale}|\${url.pathname}|\${JSON.stringify(params)}|\${cookies.get('theme') ?? ''}\`)\n})\n`
const ENDPOINT = `export function GET({ request, url, locale, params, cookies, headers, redirect, deny, notFound }) {\n${STOP}\n  cookies.set('seen', '1')\n  headers.set('x-seen', \`\${locale}|\${url.pathname}|\${JSON.stringify(params)}|\${cookies.get('theme') ?? ''}\`)\n\n  return 'ok'\n}\n`
const ACTION = `--- server\nimport { t } from 'elysia'\nimport { action } from 'kay'\n\nexport const act = action(t.Object({}), ({}, { request, url, locale, params, cookies, headers, redirect, deny, notFound }) => {\n${STOP}\n  cookies.set('seen', '1')\n  headers.set('x-seen', \`\${locale}|\${url.pathname}|\${JSON.stringify(params)}|\${cookies.get('theme') ?? ''}\`)\n\n  return 'ok'\n})\n---\nform(action={act})\n  button Go\n`

describe('the request context', () => {
  let dir = ''
  let app: Awaited<ReturnType<typeof pages>>
  let french: Awaited<ReturnType<typeof pages>>
  let mounted: Awaited<ReturnType<typeof pages>>

  const get = async (path: string, headers: Record<string, string> = {}, server = app) => {
    const response = await server.handle(new Request(`http://localhost${path}`, { headers: { cookie: 'theme=dark', ...headers }, redirect: 'manual' }))

    return { status: response.status, location: response.headers.get('location'), seen: response.headers.get('x-seen'), cookie: response.headers.get('set-cookie'), body: await response.text() }
  }
  const post = async (path: string, name: string, headers: Record<string, string> = {}, server = app, plain = false) => {
    const response = await server.handle(new Request(`http://localhost/_kay/action/${relative(process.cwd(), join(dir, 'routes'))}/${path}/${name}`, {
      method: 'POST',
      headers: { 'content-type': plain ? 'application/x-www-form-urlencoded' : 'application/json', ...(!plain && { 'x-kay-action': '1' }), 'referer': 'http://localhost/open', 'cookie': 'theme=dark', ...headers },
      body: plain ? '' : stringify({}),
    }))

    return { status: response.status, location: response.headers.get('location'), moved: response.headers.get('x-kay-redirect'), seen: response.headers.get('x-seen'), cookie: response.headers.get('set-cookie'), body: await response.text() }
  }

  beforeAll(async () => {
    dir = await scratchDir('request-context-')
    await Promise.all([
      Bun.write(join(dir, 'routes/index.kay'), '--- server\nif (ctx.request.headers.get(\'x-do\') === \'redirect\') ctx.redirect(\'/elsewhere\')\n---\nh1 Home\n'),
      Bun.write(join(dir, 'routes/guarded/_guard.ts'), GUARD),
      Bun.write(join(dir, 'routes/guarded/[id]/index.kay'), ACTION),
      Bun.write(join(dir, 'routes/guarded/report.json.ts'), ENDPOINT),
      Bun.write(join(dir, 'routes/open/index.kay'), ACTION),
      Bun.write(join(dir, 'routes/open/[name].txt.ts'), ENDPOINT),
    ])
    app = await pages({ routes: join(dir, 'routes'), prebuilt: false, security: false })
    mounted = await pages({ routes: join(dir, 'routes'), prebuilt: false, security: false, base: '/app' })
    french = await pages({ routes: join(dir, 'routes'), prebuilt: false, security: false, lang: 'fr' })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  describe('an endpoint', () => {
    it('reads the url, params, locale, cookies and locals and sets cookies and headers like a page', async () => {
      const answer = await get('/open/ada.txt')

      expect([answer.status, answer.body, answer.seen]).toEqual([200, 'ok', 'en|/open/ada.txt|{"name":"ada"}|dark'])
      expect(answer.cookie).toContain('seen=1')
      expect((await get('/open/ada.txt', {}, french)).seen).toStartWith('fr|')
    })

    it('stops with redirect, deny and notFound, as a page does, the cookies it set going with it', async () => {
      expect(await get('/open/ada.txt', { 'x-do': 'redirect' })).toMatchObject({ status: 302, location: '/elsewhere' })
      expect(await get('/open/ada.txt', { 'x-do': 'redirect-301' })).toMatchObject({ status: 301, location: '/moved' })
      expect(await get('/open/ada.txt', { 'x-do': 'deny' })).toMatchObject({ status: 402, body: 'Pay first' })
      expect(await get('/open/ada.txt', { 'x-do': 'not-found' })).toMatchObject({ status: 404, body: 'Not Found' })
    })
  })

  describe('a guard', () => {
    it('answers a page, an endpoint and an action the same way, notFound included', async () => {
      for (const [todo, expected] of [['redirect', { status: 302, location: '/elsewhere' }], ['deny', { status: 402 }], ['not-found', { status: 404 }]] as const) {
        expect(await get('/guarded/1', { 'x-do': todo })).toMatchObject(expected)
        expect(await get('/guarded/report.json', { 'x-do': todo })).toMatchObject(expected)
      }

      expect(await post('guarded/_id_/index.kay', 'act', { 'x-do': 'deny', 'x-kay-page': '/guarded/1' })).toMatchObject({ status: 402, body: 'Pay first' })
      expect(await post('guarded/_id_/index.kay', 'act', { 'x-do': 'not-found', 'x-kay-page': '/guarded/1' })).toMatchObject({ status: 404 })
    })

    it('redirects a post with 303 and a read with 302, one status per kind of request, whatever the caller', async () => {
      expect(await post('guarded/_id_/index.kay', 'act', { 'x-do': 'redirect', 'x-kay-page': '/guarded/1' })).toMatchObject({ status: 303, moved: '/elsewhere' })
      expect(await post('guarded/_id_/index.kay', 'act', { 'x-do': 'redirect-301', 'x-kay-page': '/guarded/1' })).toMatchObject({ status: 301, moved: '/moved' })
    })

    it('reads the locale the same on a page, an endpoint and an action: the site language without i18n', async () => {
      expect((await get('/guarded/1')).seen).toStartWith('en|')
      expect((await get('/guarded/report.json')).seen).toStartWith('en|')
      expect((await post('guarded/_id_/index.kay', 'act', { 'x-kay-page': '/guarded/1' })).seen).toStartWith('en|')
      expect((await get('/guarded/1', {}, french)).seen).toStartWith('fr|')
      expect((await post('guarded/_id_/index.kay', 'act', { 'x-kay-page': '/guarded/1' }, french)).seen).toStartWith('fr|')
    })
  })

  describe('an action', () => {
    it('reads the url, params, locale and cookies and sets cookies and headers', async () => {
      const answer = await post('open/index.kay', 'act', { 'x-kay-page': '/open' })

      expect(answer.seen).toBe('en|/open|{}|dark')
      expect(answer.cookie).toContain('seen=1')
    })

    it('stops with redirect, deny and notFound as a page does', async () => {
      expect(await post('open/index.kay', 'act', { 'x-do': 'redirect' })).toMatchObject({ status: 303, moved: '/elsewhere' })
      expect(await post('open/index.kay', 'act', { 'x-do': 'deny' })).toMatchObject({ status: 402, body: 'Pay first' })
      expect(await post('open/index.kay', 'act', { 'x-do': 'not-found' })).toMatchObject({ status: 404 })
    })

    it('sends a form post without JavaScript to the Location of its redirect', async () => {
      const posted = await post('open/index.kay', 'act', { 'x-do': 'redirect' }, app, true)

      expect(posted).toMatchObject({ status: 303, location: '/elsewhere' })
    })
  })

  it('puts a redirect of an endpoint, a guard and a page under base, as a page\'s always was', async () => {
    const answers = await Promise.all([get('/open/ada.txt', { 'x-do': 'redirect' }, mounted), get('/guarded/report.json', { 'x-do': 'redirect' }, mounted), get('/', { 'x-do': 'redirect' }, mounted)])

    expect(answers.map(({ status, location }) => [status, location])).toEqual([[302, '/app/elsewhere'], [302, '/app/elsewhere'], [302, '/app/elsewhere']])
  })

  it('keeps a page\'s own redirect at 302', async () => {
    expect(await get('/', { 'x-do': 'redirect' })).toMatchObject({ status: 302, location: '/elsewhere' })
  })
})
