import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { cms } from '../../../src/extension'

const ROOT = join(import.meta.dir, '..')

// The fixture's kay.config.ts calls cms() as it loads, after this one, so the settings are given again once it has.
test('serves its routes under /_kay/cms whatever the apiPath, the old path under apiPath still answering', async () => {
  const site = await testSite({ root: ROOT, extensions: [cms({})], apiPath: '/v1' })

  cms({})

  try {
    for (const path of ['/_kay/cms/sign-in', '/v1/cms/sign-in']) {
      const back = await site.fetch(`${path}?redirect=%2Fadmin`)

      expect(back.status).toBe(302)
      expect(new URL(back.headers.get('location')!, 'http://site.test').pathname).toBe('/admin/sign-in')
    }

    expect((await site.fetch('/api/cms/sign-in?redirect=%2Fadmin')).status).toBe(404)

    const page = await (await site.fetch('/about')).text()

    expect(page).toContain('<meta name="kay-api" content="/v1">')
    expect(page).toContain('/_kay/cms/editor/module.js')
  }
  finally {
    await site.close()
  }
})

test('the old /api/cms path answers under a base as /_kay/cms does, query and method kept', async () => {
  const site = await testSite({ root: ROOT, base: '/site', extensions: [cms({})] })

  cms({})

  try {
    for (const path of ['/site/_kay/cms/sign-in', '/site/api/cms/sign-in']) {
      const back = await site.fetch(`${path}?redirect=%2Fadmin`)

      expect(back.status).toBe(302)
      expect(new URL(back.headers.get('location')!, 'http://site.test').pathname).toBe('/site/admin/sign-in')
    }

    expect((await site.fetch('/site/api/cmsx/sign-in')).status).toBe(404)
  }
  finally {
    await site.close()
  }
})
